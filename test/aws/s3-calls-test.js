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
const accountConfig = require('../../lib/common/account-config')(`${__dirname}/../test-account-config.yml`).getAccountConfig();
const expect = require('chai').expect;
const AWS = require('aws-sdk-mock');
const s3Calls = require('../../lib/aws/s3-calls');
const sinon = require('sinon');

describe('s3Calls', function () {
    let sandbox;

    beforeEach(function () {
        sandbox = sinon.sandbox.create();
    });

    afterEach(function () {
        sandbox.restore();
        AWS.restore('S3');
    });

    describe('uploadFile', function () {
        it('should upload the file', function () {
            let filePath = `${__dirname}/test-upload-file.txt`;

            AWS.mock('S3', 'upload', Promise.resolve({}))

            return s3Calls.uploadFile('handel-fake-bucket', 'my-key', filePath)
                .then(uploadResponse => {
                    expect(uploadResponse).to.deep.equal({});
                });
        });
    });

    describe('listFilesByPrefix', function () {
        it('should return a list of objects when there are results', function () {
            AWS.mock('S3', 'listObjectsV2', Promise.resolve({
                Contents: [{
                    Key: "FakeKey"
                }]
            }))
            return s3Calls.listFilesByPrefix("FakeBucket", "FakePrefix")
                .then(objects => {
                    expect(objects.length).to.equal(1);
                });
        });

        it('should return an empty list when there are no results', function () {
            AWS.mock('S3', 'listObjectsV2', Promise.resolve({}))
            return s3Calls.listFilesByPrefix("FakeBucket", "FakePrefix")
                .then(objects => {
                    expect(objects.length).to.equal(0);
                });
        });
    });

    describe('deleteFiles', function () {
        it('should delete the objects', function () {
            AWS.mock('S3', 'deleteObjects', Promise.resolve({}));

            return s3Calls.deleteFiles("FakeBucket", [{ Key: "FakeKey" }])
                .then(results => {
                    expect(results).to.deep.equal({});
                });
        });
    });

    describe('cleanupOldVersionsOfFiles', function () {
        it('should clean up versions of files older than 30 days, but keeping the 5 most recent', function () {
            //5 really old objects + 1 current object. The algorithm should keep the 1 current, plus the four most recent old ones
            let oldestDate = new Date(1000);
            let objects = [
                { LastModified: oldestDate },
                { LastModified: new Date(1001) },
                { LastModified: new Date(1002) },
                { LastModified: new Date(1003) },
                { LastModified: new Date(1004) },
                { LastModified: new Date() }
            ];

            let listFilesStub = sandbox.stub(s3Calls, 'listFilesByPrefix').returns(Promise.resolve(objects));
            let deleteFilesStub = sandbox.stub(s3Calls, 'deleteFiles').returns(Promise.resolve({}));

            return s3Calls.cleanupOldVersionsOfFiles("FakeBucket", "FakePrefix")
                .then(result => {
                    expect(result).to.deep.equal({});
                    expect(listFilesStub.calledOnce).to.be.true;
                    expect(deleteFilesStub.calledOnce).to.be.true;
                    let deletedObjects = deleteFilesStub.args[0][1];
                    expect(deletedObjects.length).to.equal(1);
                    expect(deletedObjects[0].LastModified).to.equal(oldestDate);
                });
        });
    });

    describe('createBucket', function () {
        it('should create the bucket', function () {
            AWS.mock('S3', 'createBucket', Promise.resolve({}));

            return s3Calls.createBucket("handel-fake-bucket", 'us-badregion-5')
                .then(bucket => {
                    expect(bucket).to.deep.equal({});
                })
        });
    });

    describe('getBucket', function () {
        it('should return the bucket if it exists', function () {
            let bucketName = "FakeBucket";

            AWS.mock('S3', 'listBuckets', Promise.resolve({
                Buckets: [{
                    Name: bucketName
                }]
            }));

            return s3Calls.getBucket(bucketName)
                .then(bucket => {
                    expect(bucket.Name).to.equal(bucketName);
                });
        });

        it('should return null if the bucket doesnt exist', function () {
            AWS.mock('S3', 'listBuckets', Promise.resolve({
                Buckets: []
            }));

            return s3Calls.getBucket("FakeBucket")
                .then(bucket => {
                    expect(bucket).to.be.null;
                });
        });
    });

    describe('createBucketIfNotExists', function () {
        it('should return the bucket if it exists', function () {
            let getBucketStub = sandbox.stub(s3Calls, 'getBucket').returns(Promise.resolve({}));
            let createBucketStub = sandbox.stub(s3Calls, 'createBucket').returns(Promise.resolve(null));

            return s3Calls.createBucketIfNotExists("FakeBucket")
                .then(bucket => {
                    expect(bucket).to.deep.equal({});
                    expect(getBucketStub.calledOnce).to.be.true;
                    expect(createBucketStub.notCalled).to.be.true;
                });
        });

        it('should create the bucket if it doesnt exist', function () {
            let getBucketStub = sandbox.stub(s3Calls, 'getBucket');
            getBucketStub.onCall(0).returns(Promise.resolve(null));
            getBucketStub.onCall(1).returns(Promise.resolve({}));
            let createBucketStub = sandbox.stub(s3Calls, 'createBucket').returns(Promise.resolve({}));

            return s3Calls.createBucketIfNotExists("FakeBucket")
                .then(bucket => {
                    expect(bucket).to.deep.equal({});
                    expect(getBucketStub.calledTwice).to.be.true;
                    expect(createBucketStub.calledOnce).to.be.true;
                });
        });
    });
});