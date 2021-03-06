/*
 * Copyright 2017 Brigham Young University
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */
const deleteLifecycle = require('../lifecycles/delete');
const deployLifecycle = require('../lifecycles/deploy');
const checkLifecycle = require('../lifecycles/check');
const fs = require('fs');
const yaml = require('js-yaml');
const winston = require('winston');
const inquirer = require('inquirer');
const config = require('../account-config/account-config');
const AWS = require('aws-sdk');
const stsCalls = require('../aws/sts-calls');
const util = require('../common/util');

function configureLogger(argv) {
    let level = "info";
    if (argv.d) {
        level = 'debug';
    }
    winston.level = level;
    winston.cli();
}

function logCaughtError(msg, err) {
    winston.error(`${msg}: ${err.message}`);
    if (winston.level === 'debug') {
        winston.error(err);
    }
}

function logFinalResult(lifecycleName, envResults) {
    let success = true;
    for (let envResult of envResults) {
        if (envResult.status !== 'success') {
            winston.error(`Error during environment ${lifecycleName}: ${envResult.message}`);
            if (winston.level === 'debug') {
                winston.error(envResult.error);
            }
            success = false;
        }
    }

    if (success) {
        winston.info(`Finished ${lifecycleName} successfully`);
    }
    else {
        winston.error(`Finished ${lifecycleName} with errors`);
        process.exit(1);
    }
}

function validateLoggedIn() {
    AWS.config.update({ //Just use us-east-1 while we check that we are logged in.
        region: 'us-east-1'
    });
    return stsCalls.getAccountId()
        .then(accountId => {
            if (!accountId) {
                winston.error(`You are not logged into an AWS account`);
                process.exit(1);
            }
        });
}

function validateCredentials(accountConfig) {
    let deployAccount = accountConfig.account_id;
    winston.debug(`Checking that current credentials match account ${deployAccount}`);
    return stsCalls.getAccountId()
        .then(discoveredId => {
            winston.debug(`Currently logged in under account ${discoveredId}`);
            if (parseInt(deployAccount) === parseInt(discoveredId)) {
                return;
            }
            else {
                winston.error(`You are trying to deploy to the account ${deployAccount}, but you are logged into the account ${discoveredId}`);
                process.exit(1);
            }
        });
}

function validateHandelFile(handelFileParser, handelFile, serviceDeployers) {
    let errors = handelFileParser.validateHandelFile(handelFile, serviceDeployers);
    if (errors.length > 0) {
        winston.error(`The following errors were found in your Handel file:`);
        console.log("  " + errors.join("\n  "));
        process.exit(1);
    }
}


function validateAccountConfigParam(accountConfigParam) {
    let errors = [];
    if (!fs.existsSync(accountConfigParam)) { //If not a path, check whether it's base64 encoded json
        try {
            yaml.safeLoad(new Buffer(accountConfigParam, 'base64').toString());
        }
        catch (e) {
            errors.push('Account config must be either a valid path to a file, or a base64 encoded JSON string');
        }
    }
    return errors;
}

function validateEnvsInHandelFile(envsToDeploy, handelFile) {
    let errors = [];
    let envsArray = envsToDeploy.split(',');
    for (let env of envsArray) {
        if (!handelFile.environments || !handelFile.environments[env]) {
            errors.push(`Environment '${env}' was not found in your Handel file`);
        }
    }
    return errors;
}

function confirmDelete(envName, confirmDelete) {
    if (confirmDelete) {
        return Promise.resolve(true);
    }
    else {
        const warnMsg = `
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!    
WARNING: YOU ARE ABOUT TO DELETE YOUR HANDEL ENVIRONMENT '${envName}'!
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

If you choose to delete this environment, you will lose all data stored in the environment! 

In particular, you will lose all data in the following:

* Databases
* Caches
* S3 Buckets
* EFS Mounts

PLEASE REVIEW this environment thoroughly, as you are responsible for all data loss associated with an accidental deletion.
PLEASE BACKUP your data sources before deleting this environment just to be safe.
`;
        console.log(warnMsg);

        let questions = [
            {
                type: 'input',
                name: 'confirmDelete',
                message: `Enter 'yes' to delete your environment. Handel will refuse to delete the environment with any other answer:`
            }
        ]
        return inquirer.prompt(questions)
            .then(answers => {
                if (answers.confirmDelete === 'yes') {
                    return true;
                }
                else {
                    return false;
                }
            });
    }
}

exports.validateDeployArgs = function (argv, handelFile) {
    let errors = [];

    //Require account config
    if (!argv.c) {
        errors.push("The '-c' parameter is required");
    }
    else { //Validate that it is either base64 decodable JSON or an account config file
        errors = errors.concat(validateAccountConfigParam(argv.c));
    }

    //Require environments to deploy
    if (!argv.e) {
        errors.push("The '-e' parameter is required");
    }
    else { //Validate that the environments exist in the Handel file
        errors = errors.concat(validateEnvsInHandelFile(argv.e, handelFile));
    }

    //Require version
    if (!argv.v) {
        errors.push("The '-v' parameter is required");
    }

    return errors;
}

exports.validateDeleteArgs = function (argv, handelFile) {
    let errors = [];

    //Require account config
    if (!argv.c) {
        errors.push("The '-c' parameter is required");
    }
    else { //Validate that it is either base64 decodable JSON or an account config file
        errors = errors.concat(validateAccountConfigParam(argv.c));
    }

    //Require environments to deploy
    if (!argv.e) {
        errors.push("The '-e' parameter is required");
    }
    else { //Validate that the environments exist in the Handel file
        errors = errors.concat(validateEnvsInHandelFile(argv.e, handelFile));
    }

    return errors;
}

/**
 * This method is the top-level entry point for the 'deploy' action available in the
 * Handel CLI. It goes and deploys the requested environment(s) to AWS.
 */
exports.deployAction = function (handelFile, argv) {
    configureLogger(argv);

    let deployVersion = argv.v;
    let environmentsToDeploy = argv.e.split(',');
    validateLoggedIn()
        .then(() => {
            return config(argv.c) //Load account config to be consumed by the library
        })
        .then(accountConfig => {
            return validateCredentials(accountConfig)
                .then(() => {
                    //Set up AWS SDK with any global options
                    util.configureAwsSdk(accountConfig);

                    //Load all the currently implemented service deployers from the 'services' directory
                    let serviceDeployers = util.getServiceDeployers();

                    //Load Handel file from path and validate it
                    winston.debug("Validating and parsing Handel file");
                    let handelFileParser = util.getHandelFileParser(handelFile);
                    validateHandelFile(handelFileParser, handelFile, serviceDeployers);
                    return deployLifecycle.deploy(accountConfig, handelFile, environmentsToDeploy, deployVersion, handelFileParser, serviceDeployers)
                })
                .then(envDeployResults => {
                    logFinalResult('deploy', envDeployResults);
                });
        })
        .catch(err => {
            logCaughtError("Unexpected error occurred during deploy", err);
            process.exit(1);
        });
}

/**
 * This method is the top-level entry point for the 'check' action available in the
 * Handel CLI. It goes and validates the Handel file so you can see if the file looks
 * correct
 */
exports.checkAction = function (handelFile, argv) {
    configureLogger(argv); //Don't enable debug on check?

    //Load all the currently implemented service deployers from the 'services' directory
    let serviceDeployers = util.getServiceDeployers();

    //Load Handel file from path and validate it
    winston.debug("Validating and parsing Handel file");
    let handelFileParser = util.getHandelFileParser(handelFile);
    validateHandelFile(handelFileParser, handelFile, serviceDeployers);

    let errors = checkLifecycle.check(handelFile, handelFileParser, serviceDeployers);
    let foundErrors = false;
    for (let env in errors) {
        let envErrors = errors[env];
        if (envErrors.length > 0) {
            winston.error(`The following errors were found for env ${env}`);
            console.log("  " + envErrors.join("\n  "));
            foundErrors = true;
        }
    }

    if (!foundErrors) {
        winston.info("No errors were found when checking Handel file");
    }
}

/**
 * This method is the top-level entry point for the 'delete' action available in the 
 * Handel CLI. It asks for a confirmation, then deletes the requested environment.
 */
exports.deleteAction = function (handelFile, argv) {
    configureLogger(argv);

    let environmentToDelete = argv.e;
    validateLoggedIn()
        .then(() => {
            return config(argv.c) //Load account config to be consumed by the library
        })
        .then(accountConfig => {
            return validateCredentials(accountConfig)
                .then(() => {
                    return confirmDelete(environmentToDelete, argv.y);
                })
                .then(confirmDelete => {
                    if (confirmDelete) {
                        //Set up AWS SDK with any global options
                        util.configureAwsSdk(accountConfig);

                        //Load all the currently implemented service deployers from the 'services' directory
                        let serviceDeployers = util.getServiceDeployers();

                        //Load Handel file from path and validate it
                        winston.debug("Validating and parsing Handel file");
                        let handelFileParser = util.getHandelFileParser(handelFile);
                        validateHandelFile(handelFileParser, handelFile, serviceDeployers);

                        return deleteLifecycle.delete(accountConfig, handelFile, environmentToDelete, handelFileParser, serviceDeployers)
                            .then(envDeleteResult => {
                                logFinalResult('delete', [envDeleteResult]);
                            });
                    }
                    else {
                        winston.info("You did not type 'yes' to confirm deletion. Will not delete environment.");
                    }
                });
        })
        .catch(err => {
            logCaughtError("Unexpected error occurred during delete", err);
            process.exit(1);
        })

}
