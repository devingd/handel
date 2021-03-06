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
const ec2Calls = require('../../aws/ec2-calls');
const DeployContext = require('../../datatypes/deploy-context');
const cluster = require('./cluster');
const clusterAutoScalingSection = require('./cluster-auto-scaling');
const serviceAutoScalingSection = require('./service-auto-scaling');
const containersSection = require('./containers');
const volumesSection = require('./volumes');
const routingSection = require('./routing');
const asgCycling = require('./asg-cycling');
const deployPhaseCommon = require('../../common/deploy-phase-common');
const preDeployPhaseCommon = require('../../common/pre-deploy-phase-common');
const deletePhasesCommon = require('../../common/delete-phases-common');
const handlebarsUtils = require('../../common/handlebars-utils');
const route53 = require('../../aws/route53-calls');
const _ = require('lodash');

const SERVICE_NAME = "ECS";
const DEFAULT_INSTANCE_TYPE = "t2.micro";

function getTaskRoleStatements(serviceContext, dependenciesDeployContexts) {
    let ownPolicyStatements = deployPhaseCommon.getAppSecretsAccessPolicyStatements(serviceContext);

    return deployPhaseCommon.getAllPolicyStatementsForServiceRole(ownPolicyStatements, dependenciesDeployContexts);
}

function getLatestEcsAmiId() {
    return ec2Calls.getLatestAmiByName('amazon', 'amazon-ecs')
}


function getCompiledEcsTemplate(stackName, clusterName, ownServiceContext, ownPreDeployContext, dependenciesDeployContexts, userDataScript, ecsServiceRole) {
    let accountConfig = ownServiceContext.accountConfig;

    return Promise.all([getLatestEcsAmiId(), route53.listHostedZones()])
        .then(results => {
            let [latestEcsAmi, hostedZones] = results;
            let serviceParams = ownServiceContext.params;
            let instanceType = DEFAULT_INSTANCE_TYPE;
            if (serviceParams.cluster && serviceParams.cluster.instance_type) {
                instanceType = serviceParams.cluster.instance_type;
            }

            // Configure auto-scaling
            let autoScaling = serviceAutoScalingSection.getTemplateAutoScalingConfig(ownServiceContext, clusterName);

            // Configure containers in the task definition
            let containerConfigs = containersSection.getContainersConfig(ownServiceContext, dependenciesDeployContexts, clusterName);
            let oneOrMoreTasksHasRouting = routingSection.oneOrMoreTasksHasRouting(ownServiceContext);

            let logRetention = ownServiceContext.params.log_retention_in_days;

            //Create object used for templating the CloudFormation template
            let handlebarsParams = {
                clusterName,
                stackName,
                instanceType,
                minInstances: clusterAutoScalingSection.getInstanceCountForCluster(instanceType, autoScaling, containerConfigs, 'min', SERVICE_NAME),
                maxInstances: clusterAutoScalingSection.getInstanceCountForCluster(instanceType, autoScaling, containerConfigs, 'max', SERVICE_NAME),
                ecsSecurityGroupId: ownPreDeployContext.securityGroups[0].GroupId,
                amiImageId: latestEcsAmi.ImageId,
                userData: new Buffer(userDataScript).toString('base64'),
                privateSubnetIds: accountConfig.private_subnets,
                publicSubnetIds: accountConfig.public_subnets,
                asgCooldown: "60", //This is set pretty short because we handel the instance-level auto-scaling from a Lambda that runs every minute.
                minimumHealthyPercentDeployment: "50", //TODO - Do we need to support more than just 50?
                vpcId: accountConfig.vpc,
                ecsServiceRoleArn: ecsServiceRole.Arn,
                policyStatements: getTaskRoleStatements(ownServiceContext, dependenciesDeployContexts),
                deployVersion: ownServiceContext.deployVersion.toString(),
                tags: deployPhaseCommon.getTags(ownServiceContext),
                containerConfigs,
                autoScaling,
                oneOrMoreTasksHasRouting,
                // This make it default to 'enabled'
                logging: ownServiceContext.params.logging !== 'disabled',
                logGroupName: `${ownServiceContext.appName}-${ownServiceContext.environmentName}-${ownServiceContext.serviceName}`,
                //Default to not set, which means infinite.
                logRetentionInDays: logRetention !== 0 ? logRetention : null,
            };

            //Configure routing if present in any of hte containers
            if (oneOrMoreTasksHasRouting) {
                handlebarsParams.loadBalancer = routingSection.getLoadBalancerConfig(serviceParams, containerConfigs, clusterName, hostedZones, accountConfig);
            }

            //Add the SSH keypair if specified
            if (serviceParams.cluster && serviceParams.cluster.key_name) {
                handlebarsParams.sshKeyName = serviceParams.cluster.key_name
            }

            //Add volumes if present (these are consumed by one or more container mount points)
            handlebarsParams.volumes = volumesSection.getVolumes(dependenciesDeployContexts);

            return handlebarsUtils.compileTemplate(`${__dirname}/ecs-service-template.yml`, handlebarsParams)
        });
}

/**
 * This function creates a short resource name for the cluster. We don't use the standard cf stack name here because the max length
 *   of an ALB Target Group is 32 characters
 */
function getShortenedClusterName(serviceContext) {
    return `${serviceContext.appName.substring(0, 21)}-${serviceContext.environmentName.substring(0, 4)}-${serviceContext.serviceName.substring(0, 9)}`;
}


function checkLogging(serviceContext, SERVICE_NAME, errors) {
    let params = serviceContext.params;

    let logging = params.logging;
    let retention = params.log_retention_in_days;

    if (logging && !(logging === 'enabled' || logging === 'disabled')) {
        errors.push(`${SERVICE_NAME} - The 'logging' parameter must be either 'enabled' or 'disabled'`);
    }
    if (retention && typeof retention !== 'number') {
        errors.push(`${SERVICE_NAME} - The 'log_retention_in_days' parameter must be a number`);
    }
}

/**
 * Service Deployer Contract Methods
 * See https://github.com/byu-oit-appdev/handel/wiki/Creating-a-New-Service-Deployer#service-deployer-contract
 *   for contract method documentation
 */
exports.check = function (serviceContext, dependenciesServiceContexts) {
    let errors = [];

    serviceAutoScalingSection.checkAutoScalingSection(serviceContext, SERVICE_NAME, errors);
    routingSection.checkLoadBalancerSection(serviceContext, SERVICE_NAME, errors);
    containersSection.checkContainers(serviceContext, SERVICE_NAME, errors);

    checkLogging(serviceContext, SERVICE_NAME, errors);

    return errors;
}


exports.preDeploy = function (serviceContext) {
    return preDeployPhaseCommon.preDeployCreateSecurityGroup(serviceContext, 22, SERVICE_NAME);
}

exports.deploy = function (ownServiceContext, ownPreDeployContext, dependenciesDeployContexts) {
    let stackName = deployPhaseCommon.getResourceName(ownServiceContext);
    winston.info(`${SERVICE_NAME} - Deploying service '${stackName}'`);

    let clusterName = getShortenedClusterName(ownServiceContext);
    return asgCycling.getInstancesToCycle(ownServiceContext, DEFAULT_INSTANCE_TYPE)
        .then(instancesToCycle => {
            return clusterAutoScalingSection.createAutoScalingLambdaIfNotExists(ownServiceContext.accountConfig)
                .then(() => {
                    return clusterAutoScalingSection.createDrainingLambdaIfNotExists(ownServiceContext.accountConfig)
                })
                .then(() => {
                    return cluster.getUserDataScript(clusterName, dependenciesDeployContexts)
                })
                .then(userDataScript => {
                    return cluster.createEcsServiceRoleIfNotExists(ownServiceContext.accountConfig)
                        .then(ecsServiceRole => {
                            return getCompiledEcsTemplate(stackName, clusterName, ownServiceContext, ownPreDeployContext, dependenciesDeployContexts, userDataScript, ecsServiceRole)
                        });
                })
                .then(compiledTemplate => {
                    let stackTags = deployPhaseCommon.getTags(ownServiceContext)
                    return deployPhaseCommon.deployCloudFormationStack(stackName, compiledTemplate, [], true, SERVICE_NAME, stackTags);
                })
                .then(() => {
                    return asgCycling.cycleInstances(instancesToCycle)
                })
                .then(() => {
                    winston.info(`${SERVICE_NAME} - Finished deploying service '${stackName}'`);
                    let deployContext = new DeployContext(ownServiceContext);
                    return deployContext;
                });
        });
}

exports.unPreDeploy = function (ownServiceContext) {
    return deletePhasesCommon.unPreDeploySecurityGroup(ownServiceContext, SERVICE_NAME);
}

exports.unDeploy = function (ownServiceContext) {
    return deletePhasesCommon.unDeployService(ownServiceContext, SERVICE_NAME);
}

exports.producedEventsSupportedServices = [];

exports.producedDeployOutputTypes = [];

exports.consumedDeployOutputTypes = [
    'environmentVariables',
    'scripts',
    'policies',
    'securityGroups'
];

