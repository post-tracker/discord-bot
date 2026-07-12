const http = require( 'http' );
const https = require( 'https' );

const { Client, GatewayIntentBits, Events } = require( 'discord.js' );
const Redis = require( 'ioredis' );
const cron = require( 'node-cron' );

require( 'dotenv' ).config();

if ( !process.env.DISCORD_BOT_TOKEN ) {
    throw new Error( 'Unable to load Discord bot token (DISCORD_BOT_TOKEN)' );
}

if ( !process.env.DISCORD_ANNOUNCE_CHANNEL_ID ) {
    throw new Error( 'No announce channel configured (DISCORD_ANNOUNCE_CHANNEL_ID)' );
}

if ( !process.env.REDIS_URL ) {
    throw new Error( 'Got no queue string, exiting (REDIS_URL)' );
}

const API_BASE = process.env.API_BASE || 'https://api.developertracker.com';
const SITE_BASE = process.env.SITE_BASE || 'https://developertracker.com';
const ANNOUNCE_CHANNEL_ID = process.env.DISCORD_ANNOUNCE_CHANNEL_ID;

// How often to poll the API for newly added games.
const POLL_SCHEDULE = process.env.POLL_SCHEDULE || '*/5 * * * *';

// Redis keys. The known-set is the source of truth for "which games have we
// already seen"; the seeded flag lets first boot populate that set silently
// (so a fresh deploy doesn't announce every already-existing game at once).
// Both are deliberately generic so future post-monitoring can share the same
// Redis instance/namespace (e.g. dt:discord:cursor:<game>).
const KNOWN_GAMES_KEY = 'dt:discord:known-games';
const SEEDED_FLAG_KEY = 'dt:discord:seeded';

const redis = new Redis( process.env.REDIS_URL );

redis.on( 'error', ( redisError ) => {
    console.error( `[redis] ${ redisError.message }` );
} );

const client = new Client( {
    // Only the guild scope is needed to resolve + post to a channel. No
    // privileged intents (MessageContent/members) required for announcing.
    intents: [ GatewayIntentBits.Guilds ],
} );

// Minimal GET returning parsed JSON. Public GET /games already exposes
// identifier + name (the fields we announce), so no API token is needed.
// JSON.parse is wrapped so a truncated/partial upstream body rejects the
// promise (skipped, retried next tick) instead of throwing uncaught.
const getJSON = function getJSON ( requestUrl ) {
    return new Promise( ( resolve, reject ) => {
        const transport = requestUrl.startsWith( 'https:' ) ? https : http;
        const request = transport.get( requestUrl, ( response ) => {
            if ( response.statusCode < 200 || response.statusCode > 299 ) {
                reject( new Error( `GET ${ requestUrl } -> HTTP ${ response.statusCode }` ) );
                response.resume();

                return;
            }

            let body = '';

            response.on( 'data', ( chunk ) => {
                body += chunk;
            } );

            response.on( 'end', () => {
                let parsed;

                try {
                    parsed = JSON.parse( body );
                } catch ( parseError ) {
                    reject( new Error( `GET ${ requestUrl } unparseable JSON (${ body.length } bytes): ${ parseError.message }` ) );

                    return;
                }

                resolve( parsed );
            } );
        } );

        request.on( 'error', ( requestError ) => {
            reject( requestError );
        } );

        request.setTimeout( 20000, () => {
            request.destroy( new Error( `GET ${ requestUrl } timed out` ) );
        } );
    } );
};

const fetchGames = async function fetchGames () {
    const payload = await getJSON( `${ API_BASE }/games` );

    if ( !payload || !Array.isArray( payload.data ) ) {
        throw new Error( 'Unexpected /games response shape' );
    }

    // Keep only well-formed entries (identifier is the stable key we diff on).
    return payload.data.filter( ( game ) => {
        return game && game.identifier;
    } );
};

// HEAD-check a URL, resolving to the HTTP status code. Used to confirm the
// static site page actually exists before we announce it — the site is a
// separately-built Cloudflare deploy, so a game can be live in the API minutes
// before its page is published. Announcing early = a dead link.
const headStatus = function headStatus ( requestUrl ) {
    return new Promise( ( resolve, reject ) => {
        const transport = requestUrl.startsWith( 'https:' ) ? https : http;
        const request = transport.request( requestUrl, { method: 'HEAD' }, ( response ) => {
            response.resume();
            resolve( response.statusCode );
        } );

        request.on( 'error', ( requestError ) => {
            reject( requestError );
        } );

        request.setTimeout( 15000, () => {
            request.destroy( new Error( `HEAD ${ requestUrl } timed out` ) );
        } );

        request.end();
    } );
};

const isPageLive = async function isPageLive ( url ) {
    try {
        const status = await headStatus( url );

        // A published page returns 200. Some hosts answer HEAD with 405/403 but
        // still serve the page — treat those as live too. A 404 means not yet.
        return status === 200 || status === 405 || status === 403;
    } catch ( checkError ) {
        console.error( `[page-check] ${ url }: ${ checkError.message }` );

        return false;
    }
};

const announceGame = async function announceGame ( game ) {
    const channel = await client.channels.fetch( ANNOUNCE_CHANNEL_ID );

    if ( !channel || typeof channel.send !== 'function' ) {
        throw new Error( `Announce channel ${ ANNOUNCE_CHANNEL_ID } is not a sendable text channel` );
    }

    const name = game.name || game.identifier;
    const url = `${ SITE_BASE }/${ game.identifier }`;

    await channel.send( `🎮 New game now tracked: **${ name }** — ${ url }` );

    console.log( `Announced new game: ${ game.identifier }` );
};

const checkForNewGames = async function checkForNewGames () {
    const games = await fetchGames();
    const identifiers = games.map( ( game ) => {
        return game.identifier;
    } );

    const seeded = await redis.get( SEEDED_FLAG_KEY );

    if ( !seeded ) {
        // First boot against this Redis: record every current game as known
        // WITHOUT announcing, so we only ever announce games added from now on.
        if ( identifiers.length > 0 ) {
            await redis.sadd( KNOWN_GAMES_KEY, identifiers );
        }

        await redis.set( SEEDED_FLAG_KEY, Date.now().toString() );

        console.log( `Seeded ${ identifiers.length } existing games (no announcements on first run)` );

        return;
    }

    for ( const game of games ) {
        // Skip games we've already announced (in the known-set). We check
        // membership first WITHOUT adding, so that a game whose page isn't
        // built yet stays out of the set and is retried on the next tick.
        const alreadyKnown = await redis.sismember( KNOWN_GAMES_KEY, game.identifier );

        if ( alreadyKnown === 1 ) {
            continue;
        }

        // The site is a separately-built static deploy, so a new game can be
        // live in the API minutes before its page is published. Announcing now
        // would post a dead link — wait until the page actually resolves.
        const url = `${ SITE_BASE }/${ game.identifier }`;
        const pageLive = await isPageLive( url );

        if ( !pageLive ) {
            console.log( `Page not live yet, deferring announce: ${ game.identifier }` );

            continue;
        }

        // Page confirmed live — claim the game atomically. SADD returns 1 when
        // newly added; 0 means a concurrent tick already grabbed it (skip).
        const added = await redis.sadd( KNOWN_GAMES_KEY, game.identifier );

        if ( added === 1 ) {
            try {
                await announceGame( game );
            } catch ( announceError ) {
                // Announce failed — roll the membership back so the next tick
                // retries this game instead of silently swallowing it.
                await redis.srem( KNOWN_GAMES_KEY, game.identifier );
                console.error( `[announce] ${ game.identifier }: ${ announceError.message }` );
            }
        }
    }
};

let running = false;

const tick = async function tick () {
    if ( running ) {
        console.log( 'Previous run still in progress, skipping' );

        return;
    }

    running = true;

    try {
        await checkForNewGames();
    } catch ( tickError ) {
        console.error( `[tick] ${ tickError.message }` );
    } finally {
        running = false;
    }
};

client.once( Events.ClientReady, ( readyClient ) => {
    console.log( `Logged in as ${ readyClient.user.tag }` );

    // Run once on boot, then on the poll schedule.
    tick();
    cron.schedule( POLL_SCHEDULE, tick );
} );

const shutdown = async function shutdown () {
    console.log( 'Shutting down' );

    try {
        await client.destroy();
        await redis.quit();
    } catch ( closeError ) {
        console.error( closeError );
    }

    process.exit( 0 );
};

process.on( 'SIGTERM', shutdown );
process.on( 'SIGINT', shutdown );

client.login( process.env.DISCORD_BOT_TOKEN );
