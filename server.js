#!/bin/env node
//  OpenShift sample Node application
var express = require('express');
var app = express();
var http = require('http').Server(app);
var io = require('socket.io')(http);
var bodyParser = require('body-parser')
var session = require('express-session')
var fs      = require('fs');
var url = require("url");
var spawn = require('child_process').spawn;
var multer  = require('multer')

function randid(len)
{
    var text = "";
    var possible = "abcdefghijklmnopqrstuvwxyz0123456789";

    for( var i=0; i < len; i++ )
        text += possible.charAt(Math.floor(Math.random() * possible.length));

    return text;
}

var upload = multer({
    dest: '/tmp/'
   ,limits: {
       fileSize: 100*1024*1024
      ,files: 1
   }
})

var ipaddress = process.env.OPENSHIFT_NODEJS_IP || process.env.IP;
var port      = process.env.OPENSHIFT_NODEJS_PORT || process.env.PORT || 8080;

var processLog = {};

app.engine('html', require('ejs').renderFile);
app.set('views', __dirname + '/views');
app.set('view engine', 'ejs');
app.use(express.static(__dirname+"/public"))
app.use(bodyParser.urlencoded({ extended: false }))
app.use(bodyParser.json())
var express_session = session({secret: 'XmTs7K3BFGhquaH6fPV4hsJ7xrY7RUF7'})
app.use(express_session)
var sharedsession = require("express-socket.io-session");
io.use(sharedsession(express_session));
var git = {
    list: function(repo, cb){
        var gitProc = spawn('git', ['ls-remote', '-h', repo])
        var error = false
        gitProc.stderr.once('data', function(d){
            error = true;
            if(cb instanceof Function)cb(d);
        })
        var branchs = ""
        gitProc.stdout.on('data',function(d){
            if(error) return;
            branchs += d;
        })
        gitProc.stdout.on('close', function(){
            if(error) return;
            branchs = branchs.split('\n').map(function(e){
                return e.split('\t')[1]
            }).filter(function(e){return e}).map(function(e){
                return e.split('/')[2]
            }).filter(function(e){return e})
              .filter(function(e){return e.substr(-4)===".apk"})
            if(cb instanceof Function)cb(null,branchs)
        })
    }
}
app.get('/list', function(req, res){
    if(!(req.session && req.session.repo)) return res.json({error:'please login.'})
    git.list(req.session.repo, function(err, b){
        if(err) return res.json({error:'repo login failed.'})
        res.json({repo: req.session.repourl, branch: b, process: processLog[req.session.repourl]})
    })
})
app.post('/login', function(req, res){
    var repoP = url.parse(req.body.repo);
    if(!repoP.hostname)repoP.hostname = "bitbucket.org"
    if(!repoP.protocol)repoP.protocol = "https"
    if(req.body.repo.indexOf('/') === -1){
        repoP.pathname = '/' + req.body.usr + '/' + repoP.pathname
    }
    if(repoP.pathname.substr(-4)!==".git")repoP.pathname+='.git'
    repoP.auth = req.body.usr + ':' + req.body.pwd;
    var repo = url.format(repoP)
    repoP.auth = req.body.usr
    console.log("Login: "+url.format(repoP));
    git.list(repo, function(err, b){
        if(err){
            req.session.destroy();
            return res.json({error:'login failed.'})
        }
        req.session.repo = repo
        repoP.auth = req.body.usr
        req.session.repourl = url.format(repoP);
        res.json({repo: req.session.repourl, branch: b, process: processLog[req.session.repourl]})
    })
})
app.get('/logout', function(req, res){
    req.session.destroy();
    res.redirect('/');
})

function checkfn(fn){
    if(typeof(fn)!=='string')return false;
    fn = fn.match(/^[0-9a-zA-Z\.\-\_]*$/)
    if(!fn)return false;
    fn = fn[0]
    if(fn.match(/^\./))return false;
    if(fn.match(/\.$/))return false;
    if(fn.match(/\.\./))return false;
    if(fn.substr(-4) !== ".apk") return false;
    return true;
}

app.post('/upload', upload.single('apk'), function(req, res){
    //console.log(req.file);
    if(!req.session.repo){
        return res.json({error: 'Please login'})
    }
    if(!checkfn(req.file.originalname)){
        return res.json({error: 'Invalid filename'})
    }
    var branchName = req.file.originalname.replace(/\.apk$/,'')+'-'+randid(6)+'.apk'
    if(processLog[req.session.repourl]){
        return res.json({error: 'Multiple operations not permitted'})
    }
    processLog[req.session.repourl] = "Start\n"
    res.json({name: branchName})
    var decompileProc = spawn('./bin/decompile', [req.file.path, req.session.repo, branchName])
    decompileProc.stdout.on('data', function(d){
        console.log(d.toString())
        processLog[req.session.repourl] += d
        io.to(req.session.repourl).emit('process', processLog[req.session.repourl]);
    })
    decompileProc.stderr.on('data', function(d){
        console.log(d.toString())
        processLog[req.session.repourl] += d
        io.to(req.session.repourl).emit('process', processLog[req.session.repourl]);
    })
    decompileProc.on('close', function(){
        var finalLog = processLog[req.session.repourl] + '\nProcess end.'
        io.to(req.session.repourl).emit('process', finalLog);
        io.to(req.session.repourl).emit('processDone', {name: branchName});
        delete processLog[req.session.repourl];
    })
})

app.post('/compile', function(req, res){
    if(!req.session.repo){
        return res.json({error: 'Please login'})
    }
    var branchName = req.body.branch
    if(!checkfn(branchName)){
        return res.json({error: 'Invalid filename'})
    }
    if(processLog[req.session.repourl]){
        return res.json({error: 'Multiple operations not permitted'})
    }
    processLog[req.session.repourl] = "Start\n"
    res.json({name: branchName})
    var dir = '/tmp/' + randid(32);
    var compileProc = spawn('./bin/compile', [dir, req.session.repo, branchName])
    compileProc.stdout.on('data', function(d){
        console.log(d.toString())
        processLog[req.session.repourl] += d
        io.to(req.session.repourl).emit('process', processLog[req.session.repourl]);
    })
    compileProc.stderr.on('data', function(d){
        console.log(d.toString())
        processLog[req.session.repourl] += d
        io.to(req.session.repourl).emit('process', processLog[req.session.repourl]);
    })
    compileProc.on('close', function(){
        var finalLog = processLog[req.session.repourl] + '\nProcess end.'
        io.to(req.session.repourl).emit('process', finalLog);
        io.to(req.session.repourl).emit('processDone', {name: branchName});
        delete processLog[req.session.repourl];
    })
})

io.on('connection', function(socket){
    socket.join(socket.handshake.session.repourl)
});

http.listen(port, ipaddress, function(){
    console.log('Express listening on '+ipaddress+':'+port);
})
