/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var bunyan = require('bunyan');

var registrar = require('../lib');



///--- Globals

var LOG;
var ZK;



///--- Exports

module.exports = {
    get log() {
        if (!LOG) {
            LOG = bunyan.createLogger({
                level: process.env.LOG_LEVEL || 'fatal',
                name: process.argv[1],
                stream: process.stdout,
                src: true,
                serializers: bunyan.stdSerializers
            });
        }
        return (LOG);
    },

    createZkClient: function createZkClient(t) {
        var opts = {
            log: module.exports.log,
            servers: [module.exports.zkServer]
        };
        registrar.createZKClient(opts, function (err, client) {
            t.ifError(err);
            t.ok(client);
            ZK = client;
            t.end();
        });
    },

    get zkClient() {
        return (ZK);
    },

    get zkServer() {
        return ({
            host: process.env.ZK_HOST || '127.0.0.1',
            port: parseInt(process.env.ZK_PORT, 10) || 2181
        });
    }
};
