const accountConfig = require('../../../lib/util/account-config')(`${__dirname}/../../test-account-config.yml`).getAccountConfig();
const efs = require('../../../lib/services/efs');
const ec2Calls = require('../../../lib/aws/ec2-calls');
const efsCalls = require('../../../lib/aws/efs-calls');
const ServiceContext = require('../../../lib/datatypes/service-context');
const DeployContext = require('../../../lib/datatypes/deploy-context');
const PreDeployContext = require('../../../lib/datatypes/pre-deploy-context');
const BindContext = require('../../../lib/datatypes/bind-context');
const sinon = require('sinon');
const expect = require('chai').expect;

describe('efs deployer', function() {
    let sandbox;

    beforeEach(function() {
        sandbox = sinon.sandbox.create();
    });

    afterEach(function() {
        sandbox.restore();
    });

    describe('check', function() {
        it('should require either max_io or general_purpose for the performance_mode parameter', function() {
            //Errors expected
            let serviceContext = new ServiceContext("FakeApp", "FakeEnv", "FakeService", "efs", "1", {
                performance_mode: 'other_param'
            });
            let errors = efs.check(serviceContext);
            expect(errors.length).to.equal(1);
            expect(errors[0]).to.include("'performance_mode' parameter must be either");

            //No errors expected
            serviceContext.params.performance_mode = 'general_purpose';
            errors = efs.check(serviceContext);
            expect(errors.length).to.equal(0);

            //No errors expected            
            serviceContext.params.performance_mode = 'max_io';
            errors = efs.check(serviceContext);
            expect(errors.length).to.equal(0);
        });
    });

    describe('preDeploy', function() {
        it('should create a security group', function () {
            let serviceContext = new ServiceContext("FakeApp", "FakeEnv", "FakeService", "efs", "1", {});
            
            let createSecurityGroupIfNotExistsStub = sandbox.stub(ec2Calls, 'createSecurityGroupIfNotExists');
            let groupId = "FakeSgId";
            createSecurityGroupIfNotExistsStub.returns(Promise.resolve({
                GroupId: groupId
            }));
            
            return efs.preDeploy(serviceContext)
                .then(preDepoyContext => {
                    expect(preDepoyContext).to.be.instanceof(PreDeployContext);
                    expect(createSecurityGroupIfNotExistsStub.calledOnce).to.be.true;
                    expect(preDepoyContext.securityGroups.length).to.equal(1);
                    expect(preDepoyContext.securityGroups[0].GroupId).to.equal(groupId);
                });
        });
    });

    describe('bind', function() {
        it('should add the source sg to its own sg as an ingress rule', function() {
            let appName = "FakeApp";
            let envName = "FakeEnv";
            let deployVersion = "1";
            let ownServiceContext = new ServiceContext(appName, envName, "FakeService", "efs", deployVersion, {});
            let ownPreDeployContext = new PreDeployContext(ownServiceContext);
            ownPreDeployContext.securityGroups.push({
                GroupId: 'FakeId'
            });

            let dependentOfServiceContext = new ServiceContext(appName, envName, "FakeDependentOfService", "ecs", deployVersion, {});
            let dependentOfPreDeployContext = new PreDeployContext(dependentOfServiceContext);
            dependentOfPreDeployContext.securityGroups.push({
                GroupId: 'OtherId'
            });

            let addIngressRuleToSgIfNotExistsStub = sandbox.stub(ec2Calls, 'addIngressRuleToSgIfNotExists');
            addIngressRuleToSgIfNotExistsStub.returns(Promise.resolve({}));

            return efs.bind(ownServiceContext, ownPreDeployContext, dependentOfServiceContext, dependentOfPreDeployContext)
                .then(bindContext => {
                    expect(bindContext).to.be.instanceof(BindContext);
                    expect(addIngressRuleToSgIfNotExistsStub.calledOnce).to.be.true;
                });
        });
    });

    describe('deploy', function() {
        it('should create the file system if it doesnt exist', function() {
            let appName = "FakeApp";
            let envName = "FakeEnv";
            let deployVersion = "1";
            let ownServiceContext = new ServiceContext(appName, envName, "FakeService", "efs", deployVersion, {});
            let ownPreDeployContext = new PreDeployContext(ownServiceContext);
            ownPreDeployContext.securityGroups.push({
                GroupId: 'FakeId'
            });
            let dependenciesDeployContexts = [];

            let getFileSystemStub = sandbox.stub(efsCalls, 'getFileSystem').returns(Promise.resolve(null))
            let fileSystemId = "FakeFileSystemId";
            let createFileSystemStub = sandbox.stub(efsCalls, 'createFileSystem').returns(Promise.resolve({
                FileSystemId: fileSystemId
            }))

            return efs.deploy(ownServiceContext, ownPreDeployContext, dependenciesDeployContexts)
                .then(deployContext => {
                    expect(getFileSystemStub.calledOnce).to.be.true;
                    expect(createFileSystemStub.calledOnce).to.be.true;
                    expect(deployContext).to.be.instanceof(DeployContext);
                    expect(deployContext.scripts.length).to.equal(1);
                });
        });

        it('should not update the file system if it already exists', function() {
            let appName = "FakeApp";
            let envName = "FakeEnv";
            let deployVersion = "1";
            let ownServiceContext = new ServiceContext(appName, envName, "FakeService", "efs", deployVersion, {});
            let ownPreDeployContext = new PreDeployContext(ownServiceContext);
            ownPreDeployContext.securityGroups.push({
                GroupId: 'FakeId'
            });
            let dependenciesDeployContexts = [];

            let getFileSystemStub = sandbox.stub(efsCalls, 'getFileSystem').returns(Promise.resolve({}))
            let fileSystemId = "FakeFileSystemId";
            let createFileSystemStub = sandbox.stub(efsCalls, 'createFileSystem').returns(Promise.resolve({
                FileSystemId: fileSystemId
            }))

            return efs.deploy(ownServiceContext, ownPreDeployContext, dependenciesDeployContexts)
                .then(deployContext => {
                    expect(getFileSystemStub.calledOnce).to.be.true;
                    expect(createFileSystemStub.notCalled).to.be.true;
                    expect(deployContext).to.be.instanceof(DeployContext);
                    expect(deployContext.scripts.length).to.equal(1);
                });
        });
    });
});