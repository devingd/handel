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
const winston = require('winston');
const handlebarsUtils = require('../../common/handlebars-utils');
const DeployContext = require('../../datatypes/deploy-context');
const ConsumeEventsContext = require('../../datatypes/consume-events-context');
const util = require('../../common/util');
const cloudFormationCalls = require('../../aws/cloudformation-calls');
const lambdaCalls = require('../../aws/lambda-calls');
const iamCalls = require('../../aws/iam-calls')
const iotDeployersCommon = require('../../common/iot-deployers-common');
const deployPhaseCommon = require('../../common/deploy-phase-common');
const deletePhasesCommon = require('../../common/delete-phases-common');
const preDeployPhaseCommon = require('../../common/pre-deploy-phase-common');
const lifecyclesCommon = require('../../common/lifecycles-common');
const uuid = require('uuid');
const _ = require('lodash');

const SERVICE_NAME = "Lambda";

function getEnvVariablesToInject(serviceContext, dependenciesDeployContexts) {
    let serviceParams = serviceContext.params;
    let envVarsToInject = deployPhaseCommon.getEnvVarsFromDependencyDeployContexts(dependenciesDeployContexts);
    envVarsToInject = _.assign(envVarsToInject, deployPhaseCommon.getEnvVarsFromServiceContext(serviceContext));

    if (serviceParams.environment_variables) {
        for (let envVarName in serviceParams.environment_variables) {
            envVarsToInject[envVarName] = serviceParams.environment_variables[envVarName];
        }
    }
    return envVarsToInject;
}


function getCompiledLambdaTemplate(stackName, ownServiceContext, dependenciesDeployContexts, s3ArtifactInfo, securityGroups) {
    let serviceParams = ownServiceContext.params;
    let accountConfig = ownServiceContext.accountConfig;

    let policyStatements = getPolicyStatementsForLambdaRole(ownServiceContext, dependenciesDeployContexts);

    let description = serviceParams.description || 'Handel-created function ' + stackName;
    let memorySize = serviceParams.memory || 128;
    let timeout = serviceParams.timeout || 3;
    let handlebarsParams = {
        description: description,
        functionName: stackName,
        s3ArtifactBucket: s3ArtifactInfo.Bucket,
        s3ArtifactKey: s3ArtifactInfo.Key,
        handler: serviceParams.handler,
        runtime: serviceParams.runtime,
        memorySize: memorySize,
        timeout: timeout,
        policyStatements,
        tags: deployPhaseCommon.getTags(ownServiceContext)
    };

    //Inject environment variables (if any)
    let envVarsToInject = getEnvVariablesToInject(ownServiceContext, dependenciesDeployContexts);
    if (Object.keys(envVarsToInject).length > 0) {
        handlebarsParams.environmentVariables = envVarsToInject;
    }

    if (serviceParams.vpc) {
        handlebarsParams.vpc = true;
        handlebarsParams.vpcSecurityGroupIds = securityGroups;
        handlebarsParams.vpcSubnetIds = accountConfig.private_subnets;
    }
    return handlebarsUtils.compileTemplate(`${__dirname}/lambda-template.yml`, handlebarsParams)
}

function getDeployContext(serviceContext, cfStack) {
    let deployContext = new DeployContext(serviceContext);
    let lambdaArn = cloudFormationCalls.getOutput('FunctionArn', cfStack);
    let lambdaName = cloudFormationCalls.getOutput('FunctionName', cfStack);

    //Output policy for consuming this Lambda
    deployContext.policies.push({
        "Effect": "Allow",
        "Action": [
            "lambda:InvokeFunction",
            "lambda:InvokeAsync"
        ],
        "Resource": [
            lambdaArn
        ]
    });

    //Inject env vars
    deployContext.addEnvironmentVariables(deployPhaseCommon.getInjectedEnvVarsFor(serviceContext, {
        FUNCTION_ARN: lambdaArn,
        FUNCTION_NAME: lambdaName
    }));

    //Inject event outputs
    deployContext.eventOutputs.lambdaArn = lambdaArn;
    deployContext.eventOutputs.lambdaName = lambdaName;
    
    return deployContext;
}

function uploadDeployableArtifactToS3(serviceContext) {
    let s3FileName = `lambda-deployable-${uuid()}.zip`;
    winston.info(`${SERVICE_NAME} - Uploading deployable artifact to S3: ${s3FileName}`);
    let pathToArtifact = serviceContext.params.path_to_code;
    return deployPhaseCommon.uploadDeployableArtifactToHandelBucket(serviceContext, pathToArtifact, s3FileName)
        .then(s3ArtifactInfo => {
            winston.info(`${SERVICE_NAME} - Uploaded deployable artifact to S3: ${s3FileName}`);
            return s3ArtifactInfo;
        });
}

function getPolicyStatementsForLambdaRole(serviceContext, dependenciesDeployContexts) {
    let ownPolicyStatements;
    if(serviceContext.params.vpc) {
        ownPolicyStatements = JSON.parse(util.readFileSync(`${__dirname}/lambda-role-statements-vpc.json`));
    } else {
        ownPolicyStatements = JSON.parse(util.readFileSync(`${__dirname}/lambda-role-statements.json`));
    }
    ownPolicyStatements = ownPolicyStatements.concat(deployPhaseCommon.getAppSecretsAccessPolicyStatements(serviceContext));

    return deployPhaseCommon.getAllPolicyStatementsForServiceRole(ownPolicyStatements, dependenciesDeployContexts);
}

function addDynamoDBPermissions(ownServiceContext, ownDeployContext, producerServiceContext, producerDeployContext) {
    let functionName = ownDeployContext.eventOutputs.lambdaName;
    let tableStreamArn = producerDeployContext.eventOutputs.tableStreamArn;
    console.log('tableStreamArn: ', tableStreamArn);
    let tableName = producerDeployContext.eventOutputs.tableName;
    let lambdaConsumers = producerDeployContext.eventOutputs.lambdaConsumers;
    let lambdaConsumer;
    let policyStatementsToConsume = JSON.parse(util.readFileSync(`${__dirname}/lambda-dynamodb-stream-role-statements.json`));
    policyStatementsToConsume[0].Resource = [];
    let tableStreamGeneralArn = tableStreamArn.substring(0, tableStreamArn.lastIndexOf('/') + 1).concat('*')
    policyStatementsToConsume[0].Resource.push(tableStreamGeneralArn)
    return iamCalls.attachStreamPolicy(deployPhaseCommon.getResourceName(ownServiceContext), policyStatementsToConsume, ownServiceContext.accountConfig)
        .then(() => {
            winston.info(`${SERVICE_NAME} - Allowed consuming events from ${producerServiceContext.serviceName} for ${ownServiceContext.serviceName}`);
            lambdaConsumers.forEach((consumer) => {
                if (consumer.serviceName === ownServiceContext.serviceName) {
                    lambdaConsumer = consumer;
                }
            })
            if (lambdaConsumer) {
                return lambdaCalls.addLambdaEventSourceMapping(functionName, tableName, tableStreamArn, lambdaConsumer.batchSize)
                    .then(() => {
                        return new ConsumeEventsContext(ownServiceContext, producerServiceContext);
                    })
                    .catch((err) => {
                        throw err;
                    })
            } else {
                throw Error('Consumer serviceName not found in dynamodb event_consumers.')
            }
        })
}

/**
 * Service Deployer Contract Methods
 * See https://github.com/byu-oit-appdev/handel/wiki/Creating-a-New-Service-Deployer#service-deployer-contract
 *   for contract method documentation
 */

exports.check = function (serviceContext, dependenciesServiceContexts) {
    let serviceDeployers = util.getServiceDeployers()
    let errors = [];

    let serviceParams = serviceContext.params;
    if (!serviceParams.path_to_code) {
        errors.push(`${SERVICE_NAME} - The 'path_to_code' parameter is required`);
    }
    if (!serviceParams.handler) {
        errors.push(`${SERVICE_NAME} - The 'handler' parameter is required`);
    }
    if (!serviceParams.runtime) {
        errors.push(`${SERVICE_NAME} - The 'runtime' parameter is required`);
    }
    if(dependenciesServiceContexts) {
        dependenciesServiceContexts.forEach((dependencyServiceContext) => {
            if (serviceDeployers[dependencyServiceContext.serviceType].producedDeployOutputTypes.indexOf('securityGroups') !== -1 && !serviceParams.vpc) {
                errors.push(`${SERVICE_NAME} - The 'vpc' parameter is required and must be true when declaring dependencies of type ${dependencyServiceContext.serviceType}`);
            }
        })
    }

    return errors;
}

exports.preDeploy = function (serviceContext) {
    if(serviceContext.params.vpc) {
        return preDeployPhaseCommon.preDeployCreateSecurityGroup(serviceContext, null, SERVICE_NAME);
    } else {
        return lifecyclesCommon.preDeployNotRequired(serviceContext, SERVICE_NAME);
    }
}

exports.deploy = function (ownServiceContext, ownPreDeployContext, dependenciesDeployContexts) {
    let stackName = deployPhaseCommon.getResourceName(ownServiceContext);
    winston.info(`${SERVICE_NAME} - Executing Deploy on '${stackName}'`);
    let securityGroups = [];
    if(ownPreDeployContext.securityGroups) {
        ownPreDeployContext.securityGroups.forEach((secGroup) => {
            securityGroups.push(secGroup.GroupId)
        })
    }
    return uploadDeployableArtifactToS3(ownServiceContext)
        .then(s3ArtifactInfo => {
            return getCompiledLambdaTemplate(stackName, ownServiceContext, dependenciesDeployContexts, s3ArtifactInfo, securityGroups);
        })
        .then(compiledLambdaTemplate => {
            let stackTags = deployPhaseCommon.getTags(ownServiceContext);
            return deployPhaseCommon.deployCloudFormationStack(stackName, compiledLambdaTemplate, [], true, SERVICE_NAME, stackTags);
        })
        .then(deployedStack => {
            winston.info(`${SERVICE_NAME} - Finished deploying '${stackName}'`);
            return getDeployContext(ownServiceContext, deployedStack);
        });
}

exports.consumeEvents = function (ownServiceContext, ownDeployContext, producerServiceContext, producerDeployContext) {
    return new Promise((resolve, reject) => {
        winston.info(`${SERVICE_NAME} - Consuming events from service '${producerServiceContext.serviceName}' for service '${ownServiceContext.serviceName}'`);
        let functionName = ownDeployContext.eventOutputs.lambdaName;
        let producerServiceType = producerServiceContext.serviceType;
        if (producerServiceType === 'dynamodb') {
            resolve(addDynamoDBPermissions(ownServiceContext, ownDeployContext, producerServiceContext, producerDeployContext))
        } else {
            let principal;
            let sourceArn;
            if (producerServiceType === 'sns') {
                principal = producerDeployContext.eventOutputs.principal;
                sourceArn = producerDeployContext.eventOutputs.topicArn;
            }
            else if (producerServiceType === 'cloudwatchevent') {
                principal = producerDeployContext.eventOutputs.principal;
                sourceArn = producerDeployContext.eventOutputs.eventRuleArn;
            }
            else if (producerServiceType === 'alexaskillkit') {
                principal = producerDeployContext.eventOutputs.principal;
            }
            else if (producerServiceType === 'iot') {
                principal = producerDeployContext.eventOutputs.principal;
                sourceArn = iotDeployersCommon.getTopicRuleArn(producerDeployContext.eventOutputs.topicRuleArnPrefix, ownServiceContext.serviceName);
            }
            else {
                return reject(new Error(`${SERVICE_NAME} - Unsupported event producer type given: ${producerServiceType}`));
            }

            return lambdaCalls.addLambdaPermissionIfNotExists(functionName, principal, sourceArn)
                .then(() => {
                    winston.info(`${SERVICE_NAME} - Allowed consuming events from ${producerServiceContext.serviceName} for ${ownServiceContext.serviceName}`);
                    return resolve(new ConsumeEventsContext(ownServiceContext, producerServiceContext));
                });
        }
    });
}

exports.unPreDeploy = function (ownServiceContext) {
    if(ownServiceContext.params.vpc) {
        return deletePhasesCommon.unPreDeploySecurityGroup(ownServiceContext, SERVICE_NAME)
    } else {
        return lifecyclesCommon.unPreDeployNotRequired(ownServiceContext, SERVICE_NAME);
    }
}

exports.unDeploy = function (ownServiceContext) {
    return iamCalls.detachPoliciesFromRole(deployPhaseCommon.getResourceName(ownServiceContext))
        .then(() => {
            return deletePhasesCommon.unDeployService(ownServiceContext, SERVICE_NAME);
        });
}

exports.producedEventsSupportedServices = [];

exports.producedDeployOutputTypes = [
    'policies'
];

exports.consumedDeployOutputTypes = [
    'environmentVariables',
    'policies',
    'securityGroups'
];
