const NodeMediaServer = require('node-media-server');

const config = {
    auth: {
        play: false,
        publish: true,
        secret: 'vba'
    },
    rtmp: {
        port: 1935,
        chunk_size: 60000,
        gop_cache: true,
        ping: 60,
        ping_timeout: 30
    },
    http: {
        port: 8000,
        allow_origin: '*'
    }
};

const nms = new NodeMediaServer(config);
nms.on('prePublish', (id, StreamPath, args) => {
    let stream_key = StreamPath.split('/').pop();
    if (stream_key !== config.auth.secret) {
        let session = nms.getSession(id);
        session.reject();
    }
});
nms.run();