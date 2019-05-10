const dgram = require('dgram');
const Packer = require('./packet/packer');
const Xbox = require('./xbox');

module.exports = function()
{
    var id = Math.floor(Math.random() * (999 - 1)) + 1;
    var Debug = require('debug')('smartglass:client-'+id)

    var smartglassEvent = require('./events')

    return {
        _client_id: id,
        _consoles: [],
        _socket: false,
        _events: smartglassEvent,

        _last_received_time: false,
        _is_broadcast: false,
        _ip: false,
        _interval_timeout: false,

        _managers: {},

        _connection_status: false,

        discovery: function(options, callback)
        {
            if(options.ip == undefined){
                options.ip = '255.255.255.255'
                this._is_broadcast = true
            }

            this._getSocket()

            Debug('['+this._client_id+'] Crafting discovery_request packet');
            var discovery_packet = Packer('simple.discovery_request')
            var message  = discovery_packet.pack()

            var consoles_found = []

            smartglassEvent.on('_on_discovery_response', function(message, xbox, remote){
                consoles_found.push({
                    message: message.packet_decoded,
                    remote: remote
                })
            });

            this._send({
                ip: options.ip,
                port: 5050
            }, message);

            this._interval_timeout = setTimeout(function(){
                Debug('Discovery timeout after 2 sec')
                this._closeClient();
                callback(consoles_found);
            }.bind(this), 2000);
        },

        powerOn: function(options, callback)
        {
            this._getSocket();

            var poweron_packet = Packer('simple.poweron')
            poweron_packet.set('liveid', options.live_id)
            var message  = poweron_packet.pack()

            var try_num = 0;
            var sendBoot = function(client, callback)
            {
                client._send({
                    ip: options.ip,
                    port: 5050
                }, message);

                try_num = try_num+1;
                if(try_num <= options.tries)
                {
                    setTimeout(sendBoot, 500, client, callback);
                } else {
                    client._closeClient();

                    client.discovery(options, function(consoles){
                        client._closeClient();
                        if(consoles.length  >  0){
                            callback(true)
                        } else {
                            callback(false)
                        }
                    })
                }
            }
            setTimeout(sendBoot, 1000, this, callback);
        },

        powerOff: function(options, callback)
        {
            this.connect(options, function(){
                var xbox = this._consoles[options.ip];

                xbox.get_requestnum()
                var poweroff = Packer('message.power_off');
                poweroff.set('liveid', xbox._liveid)
                var message = poweroff.pack(xbox);

                this._send({
                    ip: options.ip,
                    port: 5050
                }, message);

                setTimeout(function(){
                    this.disconnect()
                }.bind(this), 1000);

                callback(true)

            }.bind(this));
        },

        connect: function(options, callback)
        {
            this._ip = options.ip

            this.discovery({
                ip: this._ip
            }, function(consoles){
                if(consoles.length > 0){
                    Debug('['+this._client_id+'] Console is online. Lets connect...')
                    clearTimeout(this._interval_timeout)

                    this._getSocket();

                    var xbox = Xbox(consoles[0].remote.address, consoles[0].message.certificate);
                    var message = xbox.connect();

                    this._send({
                        'ip': consoles[0].remote.address,
                        'port': consoles[0].remote.port
                    }, message);

                    this._consoles[this._ip] = xbox;

                    smartglassEvent.on('_on_connect_response', function(message, xbox, remote, smartglass){
                        if(message.packet_decoded.protected_payload.connect_result == '0'){
                            Debug('['+this._client_id+'] Console is connected')
                            this._connection_status = true
                            callback(true)
                        } else {
                            Debug('['+this._client_id+'] Error during connect.')
                            this._connection_status = false
                            callback(false)
                        }
                    }.bind(this))

                    smartglassEvent.on('_on_timeout', function(message, xbox, remote, smartglass){
                        Debug('['+this._client_id+'] Client timeout...')
                    }.bind(this))
                } else {
                    Debug('['+this._client_id+'] Device is offline...')
                    this._connection_status = false
                    callback(false)
                }
            }.bind(this))
        },

        on: function(name,  callback)
        {
            smartglassEvent.on(name, callback)
        },

        disconnect: function()
        {
            var xbox = this._consoles[this._ip];

            xbox.get_requestnum()

            var disconnect = Packer('message.disconnect')
            disconnect.set('reason', 4)
            disconnect.set('error_code', 0)
            var disconnect_message = disconnect.pack(xbox)

            this._send({
                ip: this._ip,
                port: 5050
            }, disconnect_message);

            this._closeClient()
        },

        addManager: function(name, manager)
        {
            Debug('Loaded manager: '+name)
            this._managers[name] = manager
            this._managers[name].load(this)
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
                //if(this._is_broadcast == true)
                //    this._socket.setBroadcast(true);
            }.bind(this))

            this._socket.on('error', function(error){
                Debug('Socket Error:')
                Debug(error)
            }.bind(this))

            this._socket.on('message', function(message, remote){
                this._last_received_time = Math.floor(Date.now() / 1000)
                var xbox = this._consoles[remote.address]
                smartglassEvent.emit('receive', message, xbox, remote, this);
            }.bind(this));

            this._socket.on('close', function() {
                Debug('['+this._client_id+'] UDP socket closed.');
            }.bind(this));

            return this._socket;
        },

        _closeClient:  function()
        {
            Debug('['+this._client_id+'] Client closed');

            clearInterval(this._interval_timeout)
            if(this._socket != false){
                this._socket.close();
                this._socket = false
            }

        },

        _send: function(options, message)
        {
            if(this._socket != false)
                this._socket.send(message, 0, message.length, options.port, options.ip, function(err, bytes) {
                     Debug('['+this._client_id+'] Sending packet to client: '+options.ip+':'+options.port);
                     Debug(message.toString('hex'))
                }.bind(this));
        },
    }
}
