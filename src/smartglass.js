const dgram = require('dgram');
const Packer = require('./packet/packer');
const Xbox = require('./xbox');
const Events = require('./events');

module.exports = function()
{
    var id = Math.floor(Math.random() * (999 - 1)) + 1;
    var Debug = require('debug')('smartglass:client-'+id)

    var events = Events()

    return {
        _client_id: id,
        _console: false,
        _socket: false,
        _events: events,

        _last_received_time: false,
        _is_broadcast: false,
        _ip: false,
        _interval_timeout: false,

        _managers: {},
        _managers_num: 0,

        _connection_status: false,
        _current_app: false,

        discovery: function(ip)
        {
            if(ip == undefined){
                this._ip = '255.255.255.255'
                this._is_broadcast = true
            } else {
                this._ip  = ip
            }

            return new Promise(function(resolve, reject) {
                this._getSocket()

                Debug('['+this._client_id+'] Crafting discovery_request packet');
                var discovery_packet = Packer('simple.discovery_request')
                var message  = discovery_packet.pack()

                var consoles_found = []

                this._events.on('_on_discovery_response', function(message, xbox, remote){
                    consoles_found.push({
                        message: message.packet_decoded,
                        remote: remote
                    })

                    if(this._is_broadcast == false){
                        Debug('Console found, clear timeout because we query an ip (direct)')
                        clearTimeout(this._interval_timeout)
                        resolve(consoles_found)
                        this._closeClient();
                    }

                }.bind(this));

                this._send(message);

                this._interval_timeout = setTimeout(function(){
                    Debug('Discovery timeout after 2 sec (broadcast)')
                    this._closeClient();

                    resolve(consoles_found)
                }.bind(this), 2000);
            }.bind(this))
        },

        getActiveApp: function()
        {
            return this._current_app
        },

        isConnected: function()
        {
            return this._connection_status
        },

        powerOn: function(options)
        {
            return new Promise(function(resolve, reject) {
                this._getSocket();

                if(options.tries == undefined){
                    options.tries =  5;
                }

                this._ip = options.ip

                var poweron_packet = Packer('simple.poweron')
                poweron_packet.set('liveid', options.live_id)
                var message  = poweron_packet.pack()

                var try_num = 0;
                var sendBoot = function(client, callback)
                {
                    client._send(message);

                    try_num = try_num+1;
                    if(try_num <= options.tries)
                    {
                        setTimeout(sendBoot, 1000, client);
                    } else {
                        client._closeClient();

                        client.discovery(options.ip).then(function(consoles){
                            if(consoles.length > 0){
                                resolve({
                                    status: 'success'
                                })
                            } else {
                                reject({
                                    status: 'error_discovery',
                                    error: 'Console was not found on network. Probably failed'
                                })
                            }
                        }, function(error){
                            reject({
                                status: 'error_discovery',
                                error: 'Console was not found on network. Probably failed'
                            })
                        })
                    }
                }
                setTimeout(sendBoot, 1000, this);
            }.bind(this))
        },

        powerOff: function()
        {
            return new Promise(function(resolve, reject) {
                if(this.isConnected() == true){
                    Debug('['+this._client_id+'] Sending power off command to: '+this._console._liveid)

                    this._console.get_requestnum()
                    var poweroff = Packer('message.power_off');
                    poweroff.set('liveid', this._console._liveid)
                    var message = poweroff.pack(this._console);

                    this._send(message);

                    setTimeout(function(){
                        this.disconnect()
                        resolve(true)
                    }.bind(this), 1000);

                } else {
                    reject({
                        status: 'error_not_connected',
                        error: 'Console is not connected'
                    })
                }
            }.bind(this))
        },

        connect: function(ip, userhash, xsts_token)
        {
            this._ip = ip

            return new Promise(function(resolve, reject) {
                this.discovery(this._ip).then(function(consoles){
                    if(consoles.length > 0){
                        Debug('['+this._client_id+'] Console is online. Lets connect...')
                        // clearTimeout(this._interval_timeout)

                        this._getSocket();

                        var xbox = Xbox(consoles[0].remote.address, consoles[0].message.certificate);
                        var message = xbox.connect(userhash, xsts_token);

                        this._send(message);

                        this._console = xbox

                        this._events.on('_on_connect_response', function(message, xbox, remote, smartglass){
                            if(message.packet_decoded.protected_payload.connect_result == '0'){
                                Debug('['+this._client_id+'] Console is connected')
                                this._connection_status = true
                                resolve()
                            } else {
                                this._connection_status = false

                                var errorTable = {
                                    0: 'Success',
                                    1: 'Pending login. Reconnect to complete',
                                    2: 'Unknown error',
                                    3: 'No anonymous connections',
                                    4: 'Device limit exceeded',
                                    5: 'Smartglass is disabled on the Xbox console',
                                    6: 'User authentication failed',
                                    7: 'Sign-in failed',
                                    8: 'Sign-in timeout',
                                    9: 'Sign-in required'
                                }

                                Debug('['+this._client_id+'] Error during connect, xbox returned result:', errorTable[message.packet_decoded.protected_payload.connect_result])
                                this._closeClient()

                                reject({
                                    'error': 'connection_rejected',
                                    'message': errorTable[message.packet_decoded.protected_payload.connect_result],
                                    'details': message.packet_decoded.protected_payload
                                })
                            }
                        }.bind(this))

                        this._events.on('_on_timeout', function(message, xbox, remote, smartglass){
                            Debug('['+this._client_id+'] Client timeout...')
                            this._connection_status = false
                            
                            reject({
                                'error': 'connection_timeout',
                                'message': 'No response from the xbox'
                            })
                        }.bind(this))
                    } else {
                        Debug('['+this._client_id+'] Device is unavailable...')
                        this._connection_status = false

                        reject({
                            'error': 'device_unavailable',
                            'message': 'Xbox is unavailable on '+ip
                        })
                    }
                }.bind(this), function(error){
                    reject(error)
                })
            }.bind(this))
        },

        on: function(name,  callback)
        {
            this._events.on(name, callback)
        },

        disconnect: function()
        {
            var xbox = this._console;

            xbox.get_requestnum()

            var disconnect = Packer('message.disconnect')
            disconnect.set('reason', 4)
            disconnect.set('error_code', 0)
            var disconnect_message = disconnect.pack(xbox)

            this._send(disconnect_message);

            this._closeClient()
        },

        recordGameDvr: function()
        {
            return new Promise(function(resolve, reject) {
                if(this.isConnected() == true){
                    if(this._console._is_authenticated == true){
                        Debug('['+this._client_id+'] Sending record game dvr command')

                        this._console.get_requestnum()
                        var game_dvr_record = Packer('message.game_dvr_record')
                        game_dvr_record.set('start_time_delta', -60) // Needs to be signed int
                        game_dvr_record.set('end_time_delta', 0)
                        var message = game_dvr_record.pack(this._console)

                        this._send(message);

                        resolve(true)
                    } else {
                        reject({
                            status: 'error_not_authenticated',
                            error: 'Game DVR record function requires an authenticated user'
                        })
                    }
                } else {
                    reject({
                        status: 'error_not_connected',
                        error: 'Console is not connected'
                    })
                }
            }.bind(this))
        },

        addManager: function(name, manager)
        {
            Debug('Loaded manager: '+name + '('+this._managers_num+')')
            this._managers[name] = manager
            this._managers[name].load(this, this._managers_num)
            this._managers_num++
        },

        getManager: function(name)
        {
            if(this._managers[name] != undefined)
                return this._managers[name]
            else
                return false
        },

        _getSocket: function()
        {
            Debug('['+this._client_id+'] Get active socket');

            this._socket = dgram.createSocket('udp4');
            this._socket.bind();

            this._socket.on('listening', function(message, remote){
                if(this._is_broadcast == true)
                   this._socket.setBroadcast(true);
            }.bind(this))

            this._socket.on('error', function(error){
                Debug('Socket Error:')
                Debug(error)
            }.bind(this))

            this._socket.on('message', function(message, remote){
                this._last_received_time = Math.floor(Date.now() / 1000)
                var xbox = this._console
                this._events.emit('receive', message, xbox, remote, this);
            }.bind(this));

            this._socket.on('close', function() {
                Debug('['+this._client_id+'] UDP socket closed.');
            }.bind(this));

            return this._socket;
        },

        _closeClient:  function()
        {
            Debug('['+this._client_id+'] Client closed');
            this._connection_status = false

            clearInterval(this._interval_timeout)
            if(this._socket != false){
                this._socket.close();
                this._socket = false
            }

        },

        _send: function(message, ip)
        {
            if(ip == undefined){
                ip = this._ip
            }

            if(this._socket != false)
                this._socket.send(message, 0, message.length, 5050, ip, function(err, bytes) {
                     Debug('['+this._client_id+'] Sending packet to client: '+this._ip+':'+5050);
                     Debug(message.toString('hex'))
                }.bind(this));
        },
    }
}
