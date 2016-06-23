/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

// Fire me up!

/**
 * Module interaction with agents.
 */
module.exports = {
    implements: 'agent-manager',
    inject: ['require(lodash)', 'require(ws)', 'require(fs)', 'require(path)', 'require(jszip)', 'require(socket.io)', 'settings', 'mongo']
};

/**
 * @param _
 * @param fs
 * @param ws
 * @param path
 * @param JSZip
 * @param socketio
 * @param settings
 * @param mongo
 * @returns {AgentManager}
 */
module.exports.factory = function(_, ws, fs, path, JSZip, socketio, settings, mongo) {
    /**
     *
     */
    class Command {
        /**
         * @param {Boolean} demo Is need run command on demo node.
         * @param {String} name Command name.
         */
        constructor(demo, name) {
            this._demo = demo;

            /**
             * Command name.
             * @type {String}
             */
            this._name = name;

            /**
             * Command parameters.
             * @type {Array.<String>}
             */
            this._params = [];
        }

        /**
         * Add parameter to command.
         * @param {string} key Parameter key.
         * @param {Object} value Parameter value.
         * @returns {Command}
         */
        addParam(key, value) {
            this._params.push({key, value});

            return this;
        }
    }

    /**
     * Connected agent descriptor.
     */
    class Agent {
        /**
         * @param {socketIo.Socket} socket - Agent socket for interaction.
         */
        constructor(socket) {
            /**
             * Agent socket for interaction.
             *
             * @type {socketIo.Socket}
             * @private
             */
            this._socket = socket;
        }

        /**
         * Send message to agent.
         *
         * @this {Agent}
         * @param {String} event Command name.
         * @param {Object} data Command params.
         * @param {Function} [callback] on finish
         */
        _emit(event, data, callback) {
            if (!this._socket.connected) {
                if (callback)
                    callback('org.apache.ignite.agent.AgentException: Connection is closed');

                return;
            }

            this._socket.emit(event, data, callback);
        }

        /**
         * Send message to agent.
         *
         * @param {String} event - Event name.
         * @param {Object?} data - Transmitted data.
         * @returns {Promise}
         */
        executeAgent(event, data) {
            return new Promise((resolve, reject) =>
                this._emit(event, data, (error, res) => {
                    if (error)
                        return reject(error);

                    resolve(res);
                })
            );
        }

        /**
         * Execute rest request on node.
         *
         * @param {Command} cmd - REST command.
         * @return {Promise}
         */
        executeRest(cmd) {
            const params = {cmd: cmd._name};

            for (const param of cmd._params)
                params[param.key] = param.value;

            return new Promise((resolve, reject) => {
                this._emit('node:rest', {uri: 'ignite', params, demo: cmd._demo, method: 'GET'}, (error, res) => {
                    if (error)
                        return reject(new Error(error));

                    error = res.error;

                    const code = res.code;

                    if (code === 401)
                        return reject(new Error('Agent is failed to authenticate in grid. Please check agent\'s login and password or node port.'));

                    if (code !== 200)
                        return reject(new Error(error || 'Failed connect to node and execute REST command.'));

                    try {
                        const msg = JSON.parse(res.data);

                        if (msg.successStatus === 0)
                            return resolve(msg.response);

                        if (msg.successStatus === 2)
                            return reject(new Error('Agent is failed to authenticate in grid. Please check agent\'s login and password or node port.'));

                        reject(new Error(msg.error));
                    }
                    catch (e) {
                        return reject(e);
                    }
                });
            });
        }

        /**
         * @param {String} driverPath
         * @param {String} driverClass
         * @param {String} url
         * @param {Object} info
         * @returns {Promise} Promise on list of tables (see org.apache.ignite.schema.parser.DbTable java class)
         */
        metadataSchemas(driverPath, driverClass, url, info) {
            return this.executeAgent('schemaImport:schemas', {driverPath, driverClass, url, info});
        }

        /**
         * @param {String} driverPath
         * @param {String} driverClass
         * @param {String} url
         * @param {Object} info
         * @param {Array} schemas
         * @param {Boolean} tablesOnly
         * @returns {Promise} Promise on list of tables (see org.apache.ignite.schema.parser.DbTable java class)
         */
        metadataTables(driverPath, driverClass, url, info, schemas, tablesOnly) {
            return this.executeAgent('schemaImport:metadata', {driverPath, driverClass, url, info, schemas, tablesOnly});
        }

        /**
         * @returns {Promise} Promise on list of jars from driver folder.
         */
        availableDrivers() {
            return this.executeAgent('schemaImport:drivers');
        }

        /**
         *
         * @param {Boolean} demo Is need run command on demo node.
         * @param {Boolean} attr Get attributes, if this parameter has value true. Default value: true.
         * @param {Boolean} mtr Get metrics, if this parameter has value true. Default value: false.
         * @returns {Promise}
         */
        topology(demo, attr, mtr) {
            const cmd = new Command(demo, 'top')
                .addParam('attr', attr !== false)
                .addParam('mtr', !!mtr);

            return this.executeRest(cmd);
        }

        /**
         *
         * @param {Boolean} demo Is need run command on demo node.
         * @param {String} cacheName Cache name.
         * @param {String} query Query.
         * @param {int} pageSize Page size.
         * @returns {Promise}
         */
        fieldsQuery(demo, cacheName, query, pageSize) {
            const cmd = new Command(demo, 'qryfldexe')
                .addParam('cacheName', cacheName)
                .addParam('qry', query)
                .addParam('pageSize', pageSize);

            return this.executeRest(cmd);
        }

        /**
         *
         * @param {Boolean} demo Is need run command on demo node.
         * @param {String} cacheName Cache name.
         * @param {int} pageSize Page size.
         * @returns {Promise}
         */
        scan(demo, cacheName, pageSize) {
            const cmd = new Command(demo, 'qryscanexe')
                .addParam('cacheName', cacheName)
                .addParam('pageSize', pageSize);

            return this.executeRest(cmd);
        }

        /**
         * @param {Boolean} demo Is need run command on demo node.
         * @param {int} queryId Query Id.
         * @param {int} pageSize Page size.
         * @returns {Promise}
         */
        queryFetch(demo, queryId, pageSize) {
            const cmd = new Command(demo, 'qryfetch')
                .addParam('qryId', queryId)
                .addParam('pageSize', pageSize);

            return this.executeRest(cmd);
        }

        /**
         * @param {Boolean} demo Is need run command on demo node.
         * @param {int} queryId Query Id.
         * @returns {Promise}
         */
        queryClose(demo, queryId) {
            const cmd = new Command(demo, 'qrycls')
                .addParam('qryId', queryId);

            return this.executeRest(cmd);
        }

        /**
         * @param {Boolean} demo Is need run command on demo node.
         * @param {String} cacheName Cache name.
         * @returns {Promise}
         */
        metadata(demo, cacheName) {
            const cmd = new Command(demo, 'metadata')
                .addParam('cacheName', cacheName);

            return this.executeRest(cmd);
        }

        /**
         * @param {Boolean} demo Is need run command on demo node.
         * @param {String} evtOrderKey Event order key, unique for tab instance.
         * @param {String} evtThrottleCntrKey Event throttle counter key, unique for tab instance.
         * @returns {Promise}
         */
        collect(demo, evtOrderKey, evtThrottleCntrKey) {
            const cmd = new Command(demo, 'exe')
                .addParam('name', 'org.apache.ignite.internal.visor.compute.VisorGatewayTask')
                .addParam('p1', '')
                .addParam('p2', 'org.apache.ignite.internal.visor.node.VisorNodeDataCollectorTask')
                .addParam('p3', 'org.apache.ignite.internal.visor.node.VisorNodeDataCollectorTaskArg')
                .addParam('p4', true)
                .addParam('p5', 'CONSOLE_' + evtOrderKey)
                .addParam('p6', evtThrottleCntrKey)
                .addParam('p7', 10)
                .addParam('p8', false);

            return this.executeRest(cmd);
        }

        /**
         * @param {Boolean} demo Is need run command on demo node.
         * @param {String} nid Node id.
         * @param {String} cacheName Cache name.
         * @returns {Promise}
         */
        cacheClear(demo, nid, cacheName) {
            const cmd = new Command(demo, 'exe')
                .addParam('name', 'org.apache.ignite.internal.visor.compute.VisorGatewayTask')
                .addParam('p1', nid)
                .addParam('p2', 'org.apache.ignite.internal.visor.cache.VisorCacheClearTask')
                .addParam('p3', 'java.lang.String')
                .addParam('p4', cacheName);

            return this.executeRest(cmd);
        }

        /**
         * @param {Boolean} demo Is need run command on demo node.
         * @param {Array.<String>} nids Node ids.
         * @param {Boolean} near true if near cache should be started.
         * @param {String} cacheName Name for near cache.
         * @param {String} cfg Cache XML configuration.
         * @returns {Promise}
         */
        cacheStart(demo, nids, near, cacheName, cfg) {
            const cmd = new Command(demo, 'exe')
                .addParam('name', 'org.apache.ignite.internal.visor.compute.VisorGatewayTask')
                .addParam('p1', nids)
                .addParam('p2', 'org.apache.ignite.internal.visor.cache.VisorCacheStartTask')
                .addParam('p3', 'org.apache.ignite.internal.visor.cache.VisorCacheStartTask$VisorCacheStartArg')
                .addParam('p4', near)
                .addParam('p5', cacheName)
                .addParam('p6', cfg);

            return this.executeRest(cmd);
        }

        /**
         * @param {Boolean} demo Is need run command on demo node.
         * @param {String} nid Node id.
         * @param {String} cacheName Cache name.
         * @returns {Promise}
         */
        cacheStop(demo, nid, cacheName) {
            const cmd = new Command(demo, 'exe')
                .addParam('name', 'org.apache.ignite.internal.visor.compute.VisorGatewayTask')
                .addParam('p1', nid)
                .addParam('p2', 'org.apache.ignite.internal.visor.cache.VisorCacheStopTask')
                .addParam('p3', 'java.lang.String')
                .addParam('p4', cacheName);

            return this.executeRest(cmd);
        }

        /**
         * @param {Boolean} demo Is need run command on demo node.
         * @param {String} nid Node id.
         * @param {String} cacheName Cache name.
         * @returns {Promise}
         */
        cacheResetMetrics(demo, nid, cacheName) {
            const cmd = new Command(demo, 'exe')
                .addParam('name', 'org.apache.ignite.internal.visor.compute.VisorGatewayTask')
                .addParam('p1', nid)
                .addParam('p2', 'org.apache.ignite.internal.visor.cache.VisorCacheResetMetricsTask')
                .addParam('p3', 'java.lang.String')
                .addParam('p4', cacheName);

            return this.executeRest(cmd);
        }

        /**
         * @param {Boolean} demo Is need run command on demo node.
         * @param {String} nid Node id.
         * @param {String} cacheNames Cache names separated by comma.
         * @returns {Promise}
         */
        cacheSwapBackups(demo, nid, cacheNames) {
            const cmd = new Command(demo, 'exe')
                .addParam('name', 'org.apache.ignite.internal.visor.compute.VisorGatewayTask')
                .addParam('p1', nid)
                .addParam('p2', 'org.apache.ignite.internal.visor.cache.VisorCacheSwapBackupsTask')
                .addParam('p3', 'java.util.Set')
                .addParam('p4', 'java.lang.String')
                .addParam('p5', cacheNames);

            return this.executeRest(cmd);
        }

        /**
         * @param {Boolean} demo Is need run command on demo node.
         * @param {String} nids Node ids.
         * @returns {Promise}
         */
        gc(demo, nids) {
            const cmd = new Command(demo, 'exe')
                .addParam('name', 'org.apache.ignite.internal.visor.compute.VisorGatewayTask')
                .addParam('p1', nids)
                .addParam('p2', 'org.apache.ignite.internal.visor.node.VisorNodeGcTask')
                .addParam('p3', 'java.lang.Void');

            return this.executeRest(cmd);
        }

        /**
         * @param {Boolean} demo Is need run command on demo node.
         * @param {String} taskNid node that is not node we want to ping.
         * @param {String} nid Id of the node to ping.
         * @returns {Promise}
         */
        ping(demo, taskNid, nid) {
            const cmd = new Command(demo, 'exe')
                .addParam('name', 'org.apache.ignite.internal.visor.compute.VisorGatewayTask')
                .addParam('p1', taskNid)
                .addParam('p2', 'org.apache.ignite.internal.visor.node.VisorNodePingTask')
                .addParam('p3', 'java.util.UUID')
                .addParam('p4', nid);

            return this.executeRest(cmd);
        }

        /**
         * @param {Boolean} demo Is need run command on demo node.
         * @param {String} nid Id of the node to get thread dump.
         * @returns {Promise}
         */
        threadDump(demo, nid) {
            const cmd = new Command(demo, 'exe')
                .addParam('name', 'org.apache.ignite.internal.visor.compute.VisorGatewayTask')
                .addParam('p1', nid)
                .addParam('p2', 'org.apache.ignite.internal.visor.debug.VisorThreadDumpTask')
                .addParam('p3', 'java.lang.Void');

            return this.executeRest(cmd);
        }
    }

    /**
     * Connected agents manager.
     */
    class AgentManager {
        /**
         * @constructor
         */
        constructor() {
            /**
             * Connected agents by user id.
             * @type {Object.<ObjectId, Array.<Agent>>}
             */
            this._agents = {};

            /**
             * Connected browsers by user id.
             * @type {Object.<ObjectId, Array.<Socket>>}
             */
            this._browsers = {};

            const agentArchives = fs.readdirSync(settings.agent.dists)
                .filter((file) => path.extname(file) === '.zip');

            /**
             * Supported agents distribution.
             * @type {Object.<String, String>}
             */
            this.supportedAgents = {};

            const jarFilter = (file) => path.extname(file) === '.jar';

            for (const archive of agentArchives) {
                const filePath = path.join(settings.agent.dists, archive);

                const zip = new JSZip(fs.readFileSync(filePath));

                const jarPath = _.find(_.keys(zip.files), jarFilter);

                const jar = new JSZip(zip.files[jarPath].asNodeBuffer());

                const manifest = jar.files['META-INF/MANIFEST.MF']
                    .asText()
                    .trim()
                    .split(/\s*\n+\s*/)
                    .map((line, r) => {
                        r = line.split(/\s*:\s*/);

                        this[r[0]] = r[1];

                        return this;
                    }, {})[0];

                const ver = manifest['Implementation-Version'];

                if (ver) {
                    this.supportedAgents[ver] = {
                        fileName: archive,
                        filePath,
                        buildTime: manifest['Build-Time']
                    };
                }
            }

            const latest = _.head(Object.keys(this.supportedAgents).sort((a, b) => {
                const aParts = a.split('.');
                const bParts = b.split('.');

                for (let i = 0; i < aParts.length; ++i) {
                    if (bParts.length === i)
                        return 1;

                    if (aParts[i] === aParts[i])
                        continue;

                    return aParts[i] > bParts[i] ? 1 : -1;
                }
            }));

            // Latest version of agent distribution.
            if (latest)
                this.supportedAgents.latest = this.supportedAgents[latest];
        }

        attachLegacy(server) {
            const wsSrv = new ws.Server({server});

            wsSrv.on('connection', (_wsClient) => {
                _wsClient.send(JSON.stringify({
                    method: 'authResult',
                    args: ['You are using an older version of the agent. Please reload agent archive']
                }));
            });
        }

        /**
         * @param {http.Server|https.Server} srv Server instance that we want to attach agent handler.
         */
        attach(srv) {
            if (this._server)
                throw 'Agent server already started!';

            this._server = srv;

            /**
             * @type {socketIo.Server}
             */
            this._socket = socketio(this._server);

            this._socket.on('connection', (socket) => {
                socket.on('agent:auth', (data, cb) => {
                    if (!_.isEmpty(this.supportedAgents)) {
                        const ver = data.ver;
                        const bt = data.bt;

                        if (_.isEmpty(ver) || _.isEmpty(bt) || _.isEmpty(this.supportedAgents[ver]) ||
                            this.supportedAgents[ver].buildTime > bt)
                            return cb('You are using an older version of the agent. Please reload agent archive');
                    }

                    const tokens = data.tokens;

                    mongo.Account.find({token: {$in: tokens}}, '_id token').lean().exec()
                        .then((accounts) => {
                            if (!accounts.length)
                                return cb('Invalid token(s), user(s) not found', false);

                            const agent = new Agent(socket);

                            const accountIds = _.map(accounts, (account) => account._id);

                            socket.on('disconnect', () => this._agentDisconnected(accountIds, agent));

                            this._agentConnected(accountIds, agent);

                            const missedTokens = _.difference(tokens, _.map(accounts, (account) => account.token));

                            if (_.isEmpty(missedTokens))
                                return cb(null, true);

                            cb('Failed to find users with token(s): ' + missedTokens.join(', '), true);
                        })
                        // TODO IGNITE-1379 send error to web master.
                        .catch((err) => cb('Failed to authorize agent by token(s)', false));
                });
            });
        }

        /**
         * @param {ObjectId} accountId
         * @param {Socket} socket
         * @returns {int} Connected agent count.
         */
        addAgentListener(accountId, socket) {
            let sockets = this._browsers[accountId];

            if (!sockets)
                this._browsers[accountId] = sockets = [];

            sockets.push(socket);

            const agents = this._agents[accountId];

            return agents ? agents.length : 0;
        }

        /**
         * @param {ObjectId} accountId
         * @param {Socket} socket
         * @returns {int} connected agent count.
         */
        removeAgentListener(accountId, socket) {
            const sockets = this._browsers[accountId];

            _.pull(sockets, socket);
        }

        /**
         * @param {ObjectId} accountId
         * @returns {Promise.<Agent>}
         */
        findAgent(accountId) {
            if (!this._server)
                return Promise.reject(new Error('Agent server not started yet!'));

            const agents = this._agents[accountId];

            if (!agents || agents.length === 0)
                return Promise.reject(new Error('Failed to connect to agent'));

            return Promise.resolve(agents[0]);
        }

        /**
         * Close connections for all user agents.
         * @param {ObjectId} accountId
         */
        close(accountId) {
            if (!this._server)
                return;

            const socketsForClose = this._agents[accountId];

            this._agents[accountId] = [];

            _.forEach(this._agents, (sockets) => _.pullAll(socketsForClose, sockets));

            _.forEach(socketsForClose, (socket) => socket._emit('agent:close', 'Security token was changed for user'));

            _.forEach(this._browsers[accountId], (socket) => socket.emit('agent:count', {count: 0}));
        }

        /**
         * @param {ObjectId} accountIds
         * @param {Agent} agent
         */
        _agentConnected(accountIds, agent) {
            _.forEach(accountIds, (accountId) => {
                let agents = this._agents[accountId];

                if (!agents)
                    this._agents[accountId] = agents = [];

                agents.push(agent);

                const sockets = this._browsers[accountId];

                _.forEach(sockets, (socket) => socket.emit('agent:count', {count: agents.length}));
            });
        }

        /**
         * @param {ObjectId} accountIds
         * @param {Agent} agent
         */
        _agentDisconnected(accountIds, agent) {
            _.forEach(accountIds, (accountId) => {
                const agents = this._agents[accountId];

                if (agents && agents.length)
                    _.pull(agents, agent);

                const sockets = this._browsers[accountId];

                _.forEach(sockets, (socket) => socket.emit('agent:count', {count: agents.length}));
            });
        }
    }

    return new AgentManager();
};
