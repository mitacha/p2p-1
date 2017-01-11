
var dgram = require('dgram');
var httpLib = require("http");
var os = require('os');
var qs = require('qs');
var fs = require('fs');

var config = JSON.parse(fs.readFileSync(__dirname+'/config.json', 'UTF-8'));
var udpport = 6660;//139.162.7.150

var keepAliveTimer = false;
var users = {};

//	First, find out our IP address
var host = [false, false];
var interfaces = os.networkInterfaces();
//console.log(interfaces);
for (var k in interfaces) {
	for (var k2 in interfaces[k]) {
		var address = interfaces[k][k2];
//console.log(address);
		if (!address.internal)
			if (address.family === 'IPv4'){
				host[0] = address.address;
				if (typeof address.mac != 'undefined')
					config.username = address.mac.replace(/:/g, '');
			}
			//else if (address.family === 'IPv6')
			//	host[1] = address.address;
	}
}

//	Create UDP socket to communicate p2p
var udp = dgram.createSocket('udp4');
if (host[0] == false && host[1] == false)
	console.log('\033[91mNo connection to outside\033[0m');
else{
	udp.bind(udpport, host[0]);
	//console.log(host);
}

/*
	message
		c: command
			ka: keep-alive
			cr1: connect request stage 1
			cr2: connect request stage 2
			qrq: query users - request
			qrs: query users - response
			...
		f: from
		h: host
		n: reequest reference number
		o: object (response data)
		p: port
		r: response reference number
		su: search user
		u: user
*/

//	Keep-alive with identity server which is another node similar to this
function keepAlive(){
	//	Only if this node has upstream servers - not a top level introducer
	if (config.servers.length > 0){
		var message = JSON.stringify({c: 'ka', u: config.username, h: host[0]});
		console.log('Sending keep-alive');
		//
		for (var i = 0; i < config.servers.length; i++)
			udp.send(new Buffer(message), 0, message.length,
				udpport, config.servers[i], function(err, bytes){
					if (err)
						console.log(err);
				});
		//
		keepAliveTimer = setTimeout(function(){
			keepAlive();
		}, config.keepAliveFreq);
	}
}
keepAlive();

/*var p2pSpool = {};
function p2pHandler(username){
}*/

//	Handler to process a UDP request expecting a response
//	and routing back to a callback - maintains reference numbers
var udpt = new (function(){
	var capsule = this;
	var spool = {};
	this.ref = 0;
	this.request = function(host, port, msg, callback){
		if (capsule == this)
			return new udpt.request(host, port, msg, callback);
		//
		if (capsule.ref > 99999)
			capsule.ref = 0;
		//	Create a reference number to handle response
		var ref = (capsule.ref += 1);
		msg.n = ref;
//console.log('['+ref+']');
		//	Store the callback with reference to call back when response cones
		spool[ref] = [host, port, callback];
		msg = JSON.stringify(msg);
		udp.send(new Buffer(msg), 0, msg.length,
			port, host, function(err, bytes){});
	},
	//	Dispatch response to callback
	this.dispatch = function(host, port, message){
		if (typeof spool[message.r] != 'undefined'){
//console.log(spool[message.r]);
			//	Verify if the response comes from where the request is sent to
			if (spool[message.r][0] != host || spool[message.r][1] != port)
				console.log('\033[91mResponder and origin mismatch\033[0m');
			var callback = spool[message.r][2];
			//	Remove the reference from index
			delete spool[message.r];
			delete message.r;
			//	Callback
			callback(message);
		}
	}
})();

// Receive incoming data from a client on udpport
udp.on('message', function(message, remote){
	console.log(remote.address + ':' + remote.port + ' - ' + message);
	//
	// Reply to incoming message by sending the directory. Whole directory for now
	message = JSON.parse(message);
	if (typeof message.c == 'string'){
		if (message.c == 'ka'){
			if (typeof users[message.u] != 'undefined')
				clearTimeout(users[message.u]['expire']);
			//	Add to directory
			users[message.u] = {inner: {host: message.h, port: udpport},
							outer: {host: remote.address, port: remote.port},
							timestamp: (new Date()).getTime()};
			//	Set Timeout to auto remove if inactive
			new (function(username){
				users[username]['expire'] = setTimeout(function(){
					console.log('Removing user \''+username+'\' for inactivity.');
					delete users[username];
				}, config.keepAliveTimeout);
			})(message.u);
			//
			/*/	Send ack - no need - it works :-) (test 1)
			message = JSON.stringify({c: 'ack', fqdn: config.fqdn});
			udp.send(new Buffer(message), 0, message.length,
				remote.port, remote.address, function(err, bytes){});*/
		}
		//	Connection request - Stage 1	- Relay to stage 2
		if (message.c == 'cr1'){
			var fromUser = users[message.f];
			var toUser = users[message.u];
			message = JSON.stringify({c: 'cr2', u: message.f,
									o: [fromUser.inner.host, fromUser.inner.port,
									fromUser.outer.host, fromUser.outer.port]});
			udp.send(new Buffer(message), 0, message.length,
				toUser.outer.port, toUser.outer.host, function(err, bytes){});
		}
		//	Connection request - Stage 2
		if (message.c == 'cr2'){
		}
	}
	//	Request that needs a response
	else if (typeof message.n != 'undefined'){
		output = {r: message.n};
		//	Search Users
		if (typeof message.su == 'string'){
			for (var user in users)
				if (user.indexOf(message.su) > -1)
					output[user] = new Buffer(
									JSON.stringify(
										[users[user].inner.host, users[user].inner.port,
										users[user].outer.host, users[user].outer.port]
									)).toString('base64');
		}
		output = JSON.stringify(output);
		udp.send(new Buffer(output), 0, output.length,
			remote.port, remote.address, function(err, bytes){});
	}
	//	Response received for a request - route it back to relevent callback
	else if (typeof message.r != 'undefined'){
		udpt.dispatch(remote.address, remote.port, message);
	}
	/*
	else
		udp.send(new Buffer(message), 0, message.length,
			remote.port, remote.address, function(err, bytes){});
	//
	// Add the caller to the directory as well
	directory[message] = {address: remote.address, port: remote.port};
	*/
});


//	Web service interface
var http = httpLib.createServer(
	function (req, res){
		//	Parse URL and query string
		var url = req.url.substring(1).split('?');
		var get = qs.parse(url[1]);
		url = url[0].split('/');
		if (url[url.length-1] == '')
			url.splice(url.length-1);
		//
		//	Deliver base template
		if (url.length == 0){
			fs.readFile(__dirname+'/views/base.html', 'utf8',
				function(err, data) {
					res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
					res.write(data);
					res.end();
				});
		}
		//	List users or search on servers
		else if (url[0] == 'users'){
			var output = {};
			res.writeHead(200, {'Content-Type': 'application/json'});
			if (url.length > 2){
				if (url[1] == 'search'){
					var progress = 0;
					for (var i = 0; i < config.servers.length; i++)
						new (function(server){
							new udpt.request(server, udpport,
								{su: url[2]},
								function(reply){
									output[server] = reply;
									progress += 1;
									if (progress == config.servers.length){
										res.write(JSON.stringify(output));
										res.end();
									}
								});
						})(config.servers[i]);	//	/*new (function(i, q){httpLib.request({port: 8080, method: 'GET', host: config.servers[i], path: '/users/'+q},function(response){handlePost(response, function(apiData){output.push(apiData);progress += 1;if (progress == config.servers.length){res.write(JSON.stringify(output));res.end();}});}).on('error', function(err){console.log(err);}).end();})(i, url[2]);*/
				}
				else if (url[1] == 'connect'){
					var user = url[2].split('@');
					if (config.username == user[0]){
						res.write(JSON.stringify({error: 'You cannot connect p2p to yourself'}));
						res.end();
					}
					else{
						message = JSON.stringify({c: 'cr1', u: user[0], f: config.username});
						udp.send(new Buffer(message), 0, message.length,
							udpport, user[1], function(err, bytes){});
						res.write(JSON.stringify({message: 'Connection request sent'}));
						res.end();
					}
				}
				else if (url[1] == 'remember'){
				}
			}
			else{
				//console.log('http: '+url+users);
				for (var user in users)
					if (url.length == 1 || user.indexOf(url[1]) > -1)
						output[user] = [[users[user].inner.host, users[user].inner.port],//s[0], users[user].inner.hosts[1]
									[users[user].outer.host, users[user].outer.port]];//, users[user].timestamp
				res.write(JSON.stringify(output));
				res.end();
			}
		}
		//	Deliver static resources as is - later we can look into minification and caching
		else if (url[0] == 'static'){
			fs.readFile(__dirname+'/'+url.join('/'), 'utf8',
				function(err, data) {
					if (err){
						console.log(err);
						res.writeHead(404, {'Content-Type': 'text/html'});
						res.end('<h1>404: Static File Not Found</h1>');
					}
					else
						res.end(data);
				});
		}
		//	Settings - read-only
		else if (url[0] == 'settings'){
			handlePost(req, function(data){
				//	To Do: Save to config.json ONCE authentication is done to access this web interface
				if (typeof data.settings != 'undefined')
					console.log('Settings Received:\n'+new Buffer(data.settings, 'base64').toString());
			});
			res.writeHead(200, {'Content-Type': 'application/json'});
			res.write(JSON.stringify(config));
			res.end();
		}
		else{
			res.write(JSON.stringify({url: url, get: get}));
			res.end();
		}
		//	Default module and method
		/*if (url.length == 0 || url[0] == '')
			url[0] = 'index';
		if (url.length == 1 || url[1] == '')
			url[1] = 'index';*/
		//
	}
);
http.on('error',
	function(e){
		console.log('--------------------------------');
		console.log('\033[91m'+e.errno+'\033[0m');
	});

http.listen(config.httpport);


//	Handler for multipart POST request/response body
function handlePost(req, callback){
	req.setEncoding('utf8');
	var body = '';
	req.on('data', function (data){
		body += data;
		//	Not receiving anything over 1Mb
		if (body.length > 1e6)
			req.connection.destroy();
	});
	req.on('end', function (data){
		var post = body;
		//	Try to parse/normalize body, either xformurlencoded or jsonencoded. hereafter it wouldn't make difference to us
		try{
			post = JSON.parse(post);
		}
		catch(e){
			try{
				post = qs.parse(post);
			}
			catch(e){}
		}
		callback(post);
	});
}

