"use strict";

/**
 * @module serverless-plugin-warmup
 *
 * @requires 'fs'
 * @requires 'path'
 * @requires 'util'
 * */
const fs = require("fs");
const path = require("path");
const util = require("util");

const writeFile = util.promisify(fs.writeFile);

/**
 * @classdesc Warms Lambdas
 * @class WarmUP
 * */
class WarmUP {
  /**
   * @description Serverless Warm Up
   * @constructor
   *
   * @param {!Object} serverless - Serverless object
   * @param {!Object} options - Serverless options
   * */
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;

    this.provider = this.serverless.getProvider("aws");

    this.hooks = {
      "after:package:initialize": this.afterPackageInitialize.bind(this),
      "after:deploy:deploy": this.afterDeployFunctions.bind(this)
    };
  }

  /**
   * @description After package initialize hook. Create warmer function and add it to the service.
   * */
  afterPackageInitialize() {
    this.options.stage =
      this.options.stage ||
      this.serverless.service.provider.stage ||
      (this.serverless.service.defaults &&
        this.serverless.service.defaults.stage) ||
      "dev";
    this.options.region =
      this.options.region ||
      this.serverless.service.provider.region ||
      (this.serverless.service.defaults &&
        this.serverless.service.defaults.region) ||
      "us-west-2";

    this.custom = this.serverless.service.custom;

    this.configPlugin();
    return this.createWarmer();
  }

  /**
   * @description After deploy functions hooks
   *
   * @fulfil {} — Functions warmed up sucessfuly
   * @reject {Error} Functions couldn't be warmed up
   *
   * @return {Promise}
   * */
  afterDeployFunctions() {
    this.configPlugin();
    if (this.warmup.prewarm) {
      return this.warmUpFunctions();
    }
  }

  /**
   * @description Configure the plugin based on the context of serverless.yml
   *
   * @return {}
   * */
  configPlugin() {
    /** Set warm up folder, file and handler paths */
    this.folderName = "_warmup";
    if (
      this.custom &&
      this.custom.warmup &&
      typeof this.custom.warmup.folderName === "string"
    ) {
      this.folderName = this.custom.warmup.folderName;
    }
    this.pathFolder = this.getPath(this.folderName);
    this.pathFile = this.pathFolder + "/index.ts";
    this.pathHandler = this.folderName + "/index.warmUp";

    /** Default options */
    this.warmup = {
      default: false,
      memorySize: 128,
      name:
        this.serverless.service.service +
        "-" +
        this.options.stage +
        "-warmup-plugin",
      schedule: ["rate(5 minutes)"],
      timeout: 10,
      source: JSON.stringify({ source: "serverless-plugin-warmup" }),
      prewarm: false
    };

    /** Set global custom options */
    if (!this.custom || !this.custom.warmup) {
      return;
    }

    /** Default warmup */
    if (typeof this.custom.warmup.default !== "undefined") {
      this.warmup.default = this.custom.warmup.default;
    }

    /** Memory size */
    if (typeof this.custom.warmup.memorySize === "number") {
      this.warmup.memorySize = this.custom.warmup.memorySize;
    }

    /** Function name */
    if (typeof this.custom.warmup.name === "string") {
      this.warmup.name = this.custom.warmup.name;
    }

    /** Role */
    if (typeof this.custom.warmup.role === "string") {
      this.warmup.role = this.custom.warmup.role;
    }

    /** Tags */
    if (typeof this.custom.warmup.tags === "object") {
      this.warmup.tags = this.custom.warmup.tags;
    }

    /** Schedule expression */
    if (typeof this.custom.warmup.schedule === "string") {
      this.warmup.schedule = [this.custom.warmup.schedule];
    } else if (Array.isArray(this.custom.warmup.schedule)) {
      this.warmup.schedule = this.custom.warmup.schedule;
    }

    /** Timeout */
    if (typeof this.custom.warmup.timeout === "number") {
      this.warmup.timeout = this.custom.warmup.timeout;
    }

    /** Source */
    if (typeof this.custom.warmup.source !== "undefined") {
      this.warmup.source = this.custom.warmup.sourceRaw
        ? this.custom.warmup.source
        : JSON.stringify(this.custom.warmup.source);
    }

    /** Pre-warm */
    if (typeof this.custom.warmup.prewarm === "boolean") {
      this.warmup.prewarm = this.custom.warmup.prewarm;
    }
  }

  /**
   * @description After create deployment artifacts
   *
   * @param {string} file — File path
   *
   * @return {String} Absolute file path
   * */
  getPath(file) {
    return path.join(this.serverless.config.servicePath, file);
  }

  /**
   * @description Warm up functions
   *
   * @return {Promise}
   * */
  async createWarmer() {
    const allFunctions = this.serverless.service.getAllFunctions();

    const functionNames = (await Promise.all(allFunctions)).filter(
      functionName => {
        const functionObject = this.serverless.service.getFunction(
          functionName
        );

        const enable = config =>
          config === true ||
          config === this.options.stage ||
          (Array.isArray(config) && config.indexOf(this.options.stage) !== -1);

        const functionConfig = functionObject.hasOwnProperty("warmup")
          ? functionObject.warmup
          : this.warmup.default;

        return enable(functionConfig);
      }
    );

    if (!functionNames.length) {
      this.serverless.cli.log("WarmUP: no lambda to warm");
      return true;
    }

    const skip = await this.createWarmUpFunctionArtifact(functionNames);

    if (skip !== true) return this.addWarmUpFunctionToService();
  }

  /**
   * @description Write warm up ES6 function
   *
   * @param {Array} functionNames - Function names
   *
   * @return {Promise}
   * */
  createWarmUpFunctionArtifact(functionNames) {
    this.serverless.cli.log(
      `WarmUP: ${functionNames.length} lambdas will be warmed`
    );

    functionNames = functionNames.map(functionName => {
      const functionObject = this.serverless.service.getFunction(functionName);
      this.serverless.cli.log("WarmUP: " + functionObject.name);
      return functionObject.name;
    });

    const warmUpFunction = `"use strict";

/** Generated by Serverless WarmUP Plugin at ${new Date().toISOString()} */
/* tslint:disable */
import * as aws from 'aws-sdk';
const lambda = new aws.Lambda();
const functionNames = ${JSON.stringify(functionNames)};
module.exports.warmUp = async () => {
  console.log("Warm Up Start");
  const invokes = await Promise.all(functionNames.map(async (functionName) => {
    const params = {
      ClientContext: "${Buffer.from(
        `{"custom":${this.warmup.source}}`
      ).toString("base64")}",
      FunctionName: functionName,
      InvocationType: "RequestResponse",
      LogType: "None",
      Qualifier: process.env.SERVERLESS_ALIAS || "$LATEST",
      Payload: '${this.warmup.source}'
    };

    try {
      const data = await lambda.invoke(params).promise();
      console.log(\`Warm Up Invoke Success: \${functionName}\`, data);
      return true;
    } catch (e) {
      console.log(\`Warm Up Invoke Error: \${functionName}\`, e);
      return false;
    }
  }));

  console.log(\`Warm Up Finished with \${invokes.filter(r => !r).length} invoke errors\`);
}
/* tslint:enable */
`;

    return writeFile(this.pathFile, warmUpFunction);
  }

  /**
   * @description Add warm up function to service
   *
   * @return {Object} Warm up service function object
   * */
  addWarmUpFunctionToService() {
    /** SLS warm up function */
    this.serverless.service.functions.warmUpPlugin = {
      description: "Serverless WarmUP Plugin",
      events: this.warmup.schedule.map(schedule => ({ schedule })),
      handler: this.pathHandler,
      memorySize: this.warmup.memorySize,
      name: this.warmup.name,
      runtime: "nodejs8.10",
      package: {
        exclude: ["**"],
        include: [this.folderName + "/**"]
      },
      timeout: this.warmup.timeout
    };

    if (this.warmup.role) {
      this.serverless.service.functions.warmUpPlugin.role = this.warmup.role;
    }

    if (this.warmup.tags) {
      this.serverless.service.functions.warmUpPlugin.tags = this.warmup.tags;
    }

    return this.serverless.service.functions.warmUpPlugin;
  }

  /**
   * @description Warm up the functions immediately after deployment
   *
   * @return {Promise}
   * */
  async warmUpFunctions() {
    this.serverless.cli.log("WarmUP: Pre-warming up your functions");

    const params = {
      FunctionName: this.warmup.name,
      InvocationType: "RequestResponse",
      LogType: "None",
      Qualifier: process.env.SERVERLESS_ALIAS || "$LATEST",
      Payload: this.warmup.source
    };

    try {
      await this.provider.request("Lambda", "invoke", params);
      this.serverless.cli.log("WarmUp: Functions sucessfuly pre-warmed");
    } catch (error) {
      this.serverless.cli.log(
        "WarmUp: Error while pre-warming functions",
        error
      );
    }
  }
}

module.exports = WarmUP;
