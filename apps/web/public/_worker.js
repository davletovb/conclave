// Serves the Seatline relay from the website's own origin. Browsers treat a connection to a second domain
// (the relay's workers.dev address) as third-party, and some block it outright; a same-origin path is never
// blocked. The relay itself is unchanged: this forwards /pair and /channels/* to the seatline-relay Worker
// through the RELAY service binding, WebSocket upgrades included, and serves everything else as static files.
const RELAYED = /^\/(?:pair|channels\/.*)$/;

export default {
  async fetch(request, env) {
    if (!RELAYED.test(new URL(request.url).pathname)) return env.ASSETS.fetch(request);
    if (!env.RELAY) {
      return new Response("The Seatline relay is not connected to this site (missing RELAY service binding).", { status: 503 });
    }
    return env.RELAY.fetch(request);
  },
};
