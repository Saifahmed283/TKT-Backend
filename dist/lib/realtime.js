// In-memory realtime hub. Backed by SSE streams; publish() fans out
// to all subscribed clients for a channel.
// Channels: `event:{eventId}:access`, `event:{eventId}:incident`,
// `event:{eventId}:task`, `event:{eventId}:announcement`, `event:{eventId}:activity`
const channels = new Map();
export function subscribe(channel, listener) {
    let set = channels.get(channel);
    if (!set) {
        set = new Set();
        channels.set(channel, set);
    }
    set.add(listener);
    return () => {
        set.delete(listener);
        if (set.size === 0)
            channels.delete(channel);
    };
}
export function publish(channel, event, payload) {
    const set = channels.get(channel);
    if (!set || set.size === 0)
        return;
    const data = JSON.stringify(payload);
    for (const listener of set) {
        try {
            listener({ event, data });
        }
        catch (err) {
            console.error('[hub] listener error', err);
        }
    }
}
export function attachSse(reply, channel) {
    const res = reply.raw;
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 3000\n\n`);
    res.write(`event: connected\ndata: {"channel":"${channel}"}\n\n`);
    const unsubscribe = subscribe(channel, (msg) => {
        res.write(`event: ${msg.event}\ndata: ${msg.data}\n\n`);
    });
    const heartbeat = setInterval(() => {
        res.write(`: hb\n\n`);
    }, 15000);
    res.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
    });
    return () => {
        clearInterval(heartbeat);
        unsubscribe();
    };
}
export const channelFor = {
    access: (eventId) => `event:${eventId}:access`,
    incident: (eventId) => `event:${eventId}:incident`,
    task: (eventId) => `event:${eventId}:task`,
    announcement: (eventId) => `event:${eventId}:announcement`,
    activity: (eventId) => `event:${eventId}:activity`,
    reservation: (eventId) => `event:${eventId}:reservation`,
};
//# sourceMappingURL=realtime.js.map