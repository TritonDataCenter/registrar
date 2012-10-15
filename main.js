// Copyright (c) 2012, Joyent, Inc. All rights reserved.

var assert = require('assert');
var fs = require('fs');
var os = require('os');

var bunyan = require('bunyan');
var clone = require('clone');
var getopt = require('posix-getopt');
var vasync = require('vasync');
var zkplus = require('zkplus');



///--- Globals

var ARGV;
var CFG;
var LOG = bunyan.createLogger({
        level: (process.env.LOG_LEVEL || 'info'),
        name: 'registrar',
        serializers: {
                err: bunyan.stdSerializers.err
        },
        stream: process.stdout
});
var ZK;



///--- Helpers

function address() {
        var ifaces = os.networkInterfaces();
        var addrs = Object.keys(ifaces).filter(function (k) {
                return (!ifaces[k][0].internal);
        }).map(function (k) {
                return (ifaces[k][0]);
        });

        return (addrs[0].address);
}


// domainToPath(1.moray.sds.joyent.com) => /com/joyent/sds/moray/1
function domainToPath(domain) {
        assert.ok(domain);
        return ('/' + domain.split('.').reverse().join('/'));
}


function parseOptions() {
        var option;
        var opts = {};
        var parser = new getopt.BasicParser('vf:(file)', process.argv);

        while ((option = parser.getopt()) !== undefined) {
                switch (option.option) {
                case 'f':
                        opts.file = option.optarg;
                        break;

                case 'v':
                        // Allows us to set -vvv -> this little hackery
                        // just ensures that we're never < TRACE
                        LOG.level(Math.max(bunyan.TRACE, (LOG.level() - 10)));
                        if (LOG.level() <= bunyan.DEBUG)
                                LOG = LOG.child({src: true});
                        break;

                default:
                        console.error('invalid option: ' + option.option);
                        process.exit(1);
                        break;
                }
        }

        ARGV = opts;
        return (opts);
}


function readConfig(opts) {
        if (!CFG) {
                CFG = JSON.parse(fs.readFileSync(opts.file, 'utf8'));
                LOG.info({config: CFG, file: opts.file}, 'Configuration loaded');
        }

        return (CFG);
}


function removeOldEntry(opts, callback) {
        assert.ok(opts);
        assert.ok(callback);

        var log = opts.log;
        var hostname = os.hostname();
        var path = opts.path + '/' + hostname;
        var zk = opts.zk;

        log.debug({
                domain: opts.cfg.domain,
                path: path
        }, 'removeOldEntry: entered');

        zk.unlink(path, function (err) {
                if (err && err.code !== zkplus.ZNONODE) {
                        log.error({
                                domain: opts.cfg.domain,
                                err: err,
                                path: path
                        }, 'removeOldEntry: zk.unlink failed');
                        callback(err);
                } else {
                        log.debug({
                                domain: opts.cfg.domain,
                                path: path
                        }, 'removeOldEntry: done');
                        callback();
                }
        });
}

function registerSelf(opts, callback) {
        assert.ok(opts);
        assert.ok(callback);

        var cfg = opts.cfg;
        var domain = opts.cfg.domain;
        var log = opts.log;
        var hostname = os.hostname();
        var path = opts.path + '/' + hostname;
        var zk = opts.zk;

        log.debug({
                domain: domain,
                hostname: hostname,
                path: path
        }, 'registerSelf: entered');

        zk.mkdirp(opts.path, function (err) {
                if (err) {
                        log.error({
                                domain: domain,
                                hostname: hostname,
                                path: opts.path,
                                err: err
                        }, 'registerSelf: zk.mkdirp failed');
                        return (callback(err));
                }

                log.debug({
                        domain: domain,
                        hostname: hostname,
                        path: opts.path
                }, 'registerSelf: zk.mkdirp done');

                var options = {
                        flags: ['ephemeral'],
                        object: {
                                type: cfg.type
                        }
                };
                options.object[cfg.type] = {
                        address: address()
                };
                if (typeof (cfg.ttl) === 'number')
                        options.object.ttl = cfg.ttl;

                zk.creat(path, options, function (err2) {
                        if (err2 && err2.code !== zkplus.ZNODEEXISTS) {
                                log.error({
                                        domain: domain,
                                        hostname: hostname,
                                        path: path,
                                        err: err
                                }, 'registerSelf: zk.put failed');
                                return (callback(err2));
                        }

                        log.info({
                                domain: domain,
                                hostname: hostname,
                                path: path,
                                data: options
                        }, 'registerSelf: done');
                        return (callback(null));
                });
                return (undefined);
        });
}


function registerService(opts, callback) {
        assert.ok(opts);
        assert.ok(callback);

        if (!opts.cfg.service)
                return (callback());

        var cfg = opts.cfg;
        var domain = opts.cfg.domain;
        var log = opts.log;
        var path = opts.path;
        var zk = opts.zk;

        log.debug({
                domain: domain,
                path: path
        }, 'registerService: entered');

        var obj = {
                type: 'service',
                service: cfg.service
        };
        zk.update(path, obj, function (err) {
                if (err) {
                        log.error({
                                domain: domain,
                                path: path,
                                err: err
                        }, 'registerService: zk.update failed');
                } else {
                        log.debug({
                                domain: domain,
                                path: path
                        }, 'registerService: zk.update done');
                }

                callback(err || null);
        });

        return (undefined);
}


function run() {
        LOG.info({
                registration: CFG.registration,
                zk: CFG.zookeeper,
                path: domainToPath(CFG.registration.domain)
        }, 'ZooKeeper connection successful; registering.');

        // register $self in ZK depending on the type. We always
        // write a leadnode for ourselves, but we may need to additionally
        // set a service record.
        vasync.pipeline({
                arg: {
                        cfg: CFG.registration,
                        log: LOG,
                        path: domainToPath(CFG.registration.domain),
                        zk: ZK
                },
                funcs: [
                        removeOldEntry,
                        function sleepForTickTime(_, cb) {
                                LOG.info('waiting for %ds',
                                         (CFG.initialWaitTime / 1000));
                                setTimeout(cb.bind(null), CFG.initialWaitTime);
                        },
                        registerSelf,
                        registerService]
        }, function (err) {
                if (err) {
                        LOG.fatal(err, 'Unable to register in ZooKeeper');
                        process.exit(1);
                }
        });
}


///--- Mainline

readConfig(parseOptions());
CFG.zookeeper.log = LOG;

ZK = zkplus.createClient(CFG.zookeeper);
ZK.once('connect', run);

ZK.on('close', function () {
        LOG.fatal('ZooKeeper session closed; exiting');
        process.exit(1);
});

ZK.on('error', function (err) {
        LOG.fatal(err, 'ZooKeeper error event; exiting');
        process.exit(1);
});
