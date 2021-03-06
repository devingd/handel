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
const redis = require('../../../lib/services/redis');
const ServiceContext = require('../../../lib/datatypes/service-context');
const DeployContext = require('../../../lib/datatypes/deploy-context');
const PreDeployContext = require('../../../lib/datatypes/pre-deploy-context');
const BindContext = require('../../../lib/datatypes/bind-context');
const deployPhaseCommon = require('../../../lib/common/deploy-phase-common');
const bindPhaseCommon = require('../../../lib/common/bind-phase-common');
const preDeployPhaseCommon = require('../../../lib/common/pre-deploy-phase-common');
const deletePhasesCommon = require('../../../lib/common/delete-phases-common');
const UnPreDeployContext = require('../../../lib/datatypes/un-pre-deploy-context');
const UnBindContext = require('../../../lib/datatypes/un-bind-context');
const UnDeployContext = require('../../../lib/datatypes/un-deploy-context');
const sinon = require('sinon');
const expect = require('chai').expect;

const config = require('../../../lib/account-config/account-config');

describe('redis deployer', function () {
    let sandbox;
    let appName = "FakeApp";
    let envName = "FakeEnv";
    let serviceContext;

    beforeEach(function () {
        return config(`${__dirname}/../../test-account-config.yml`)
            .then(accountConfig => {
                sandbox = sinon.sandbox.create();
                serviceContext = new ServiceContext(appName, envName, "FakeService", "redis", "1", {}, accountConfig);
            });
    });

    afterEach(function () {
        sandbox.restore();
    });

    describe('check', function () {
        it('should do require the instance_type parameter', function () {
            serviceContext.params = {
                redis_version: '3.2.4'
            }
            let errors = redis.check(serviceContext);
            expect(errors.length).to.equal(1);
            expect(errors[0]).to.contain(`'instance_type' parameter is required`);
        });

        it('should require the redis_version parameter', function () {
            serviceContext.params = {
                instance_type: 'cache.t2.micro'
            }
            let errors = redis.check(serviceContext);
            expect(errors.length).to.equal(1);
            expect(errors[0]).to.contain(`'redis_version' parameter is required`);
        });

        it('should fail if the read_replicas parameter is not between 0-5', function () {
            serviceContext.params = {
                redis_version: '3.2.4',
                instance_type: 'cache.m3.medium',
                read_replicas: 6
            }
            let errors = redis.check(serviceContext);
            expect(errors.length).to.equal(1);
            expect(errors[0]).to.contain(`'read_replicas' parameter may only have a value of 0-5`);
        });

        it('should fail if the instance_type is a t* class when using replication', function () {
            serviceContext.params = {
                redis_version: '3.2.4',
                instance_type: 'cache.t2.micro',
                read_replicas: 5
            }
            let errors = redis.check(serviceContext);
            expect(errors.length).to.equal(1);
            expect(errors[0]).to.contain(`You may not use the 't1' and 't2' instance types when using any read replicas`);
        });

        it('should work when all parameters are provided properly', function () {
            serviceContext.params = {
                redis_version: '3.2.4',
                instance_type: 'cache.m3.medium',
                read_replicas: 5
            }
            let errors = redis.check(serviceContext);
            expect(errors.length).to.equal(0);
        });
    });

    describe('preDeploy', function () {
        it('should create a security group', function () {
            let groupId = "FakeSgGroupId";
            let preDeployContext = new PreDeployContext(serviceContext);
            preDeployContext.securityGroups.push({
                GroupId: groupId
            });
            let preDeployCreateSgStub = sandbox.stub(preDeployPhaseCommon, 'preDeployCreateSecurityGroup').returns(Promise.resolve(preDeployContext));

            return redis.preDeploy(serviceContext)
                .then(preDeployContext => {
                    expect(preDeployContext).to.be.instanceof(PreDeployContext);
                    expect(preDeployContext.securityGroups.length).to.equal(1);
                    expect(preDeployContext.securityGroups[0].GroupId).to.equal(groupId);
                    expect(preDeployCreateSgStub.callCount).to.equal(1);
                });
        });
    });

    describe('bind', function () {
        it('should add the source sg to its own sg as an ingress rule', function () {
            let bindSgStub = sandbox.stub(bindPhaseCommon, 'bindDependentSecurityGroupToSelf').returns(Promise.resolve(new BindContext({}, {})));

            return redis.bind({}, {}, {}, {})
                .then(bindContext => {
                    expect(bindContext).to.be.instanceof(BindContext);
                    expect(bindSgStub.callCount).to.equal(1);
                });
        });
    });

    describe('deploy', function () {
        it('should deploy the cluster', function () {
            serviceContext.params = {
                redis_version: '3.2.4',
                instance_type: 'cache.t2.micro'
            }
            let ownPreDeployContext = new PreDeployContext(serviceContext);
            ownPreDeployContext.securityGroups.push({
                GroupId: 'FakeId'
            });
            let dependenciesDeployContexts = [];

            let cacheAddress = "fakeaddress.byu.edu";
            let cachePort = 6379;
            let envPrefix = 'FAKESERVICE';

            let deployStackStub = sandbox.stub(deployPhaseCommon, 'deployCloudFormationStack').returns(Promise.resolve({
                Outputs: [
                    {
                        OutputKey: "CacheAddress",
                        OutputValue: cacheAddress
                    },
                    {
                        OutputKey: "CachePort",
                        OutputValue: cachePort
                    }
                ]
            }));

            return redis.deploy(serviceContext, ownPreDeployContext, dependenciesDeployContexts)
                .then(deployContext => {
                    expect(deployStackStub.calledOnce).to.be.true;
                    expect(deployContext).to.be.instanceof(DeployContext);
                    expect(deployContext.environmentVariables[`${envPrefix}_ADDRESS`]).to.equal(cacheAddress);
                    expect(deployContext.environmentVariables[`${envPrefix}_PORT`]).to.equal(cachePort);
                });
        });
    });

    describe('unPreDeploy', function () {
        it('should delete the security group', function () {
            let unPreDeployStub = sandbox.stub(deletePhasesCommon, 'unPreDeploySecurityGroup').returns(Promise.resolve(new UnPreDeployContext({})));

            return redis.unPreDeploy({})
                .then(unPreDeployContext => {
                    expect(unPreDeployContext).to.be.instanceof(UnPreDeployContext);
                    expect(unPreDeployStub.callCount).to.equal(1);
                });
        });
    });

    describe('unBind', function () {
        it('should unbind the security group', function () {
            let unBindStub = sandbox.stub(deletePhasesCommon, 'unBindSecurityGroups').returns(Promise.resolve(new UnBindContext({})));

            return redis.unBind({})
                .then(unBindContext => {
                    expect(unBindContext).to.be.instanceof(UnBindContext);
                    expect(unBindStub.callCount).to.equal(1);
                });
        });
    });

    describe('unDeploy', function () {
        it('should undeploy the stack', function () {
            let serviceContext = new ServiceContext("FakeApp", "FakeEnv", "FakeService", "redis", "1", {});
            let unDeployStackStub = sandbox.stub(deletePhasesCommon, 'unDeployService').returns(Promise.resolve(new UnDeployContext(serviceContext)));

            return redis.unDeploy(serviceContext)
                .then(unDeployContext => {
                    expect(unDeployContext).to.be.instanceof(UnDeployContext);
                    expect(unDeployStackStub.calledOnce).to.equal.true;
                });
        });
    });
});
