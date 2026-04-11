import { WebClient } from '@slack/web-api';
import { AgentStatus, Profile, AppSettings } from '../shared/types';

let client: WebClient | null = null;
let pollInterval: ReturnType<typeof setInterval> | null = null;
let lastTimestamps: Map<string, string> = new Map(); // channelId → last message ts

// Callback for when a Slack message arrives for a profile
let onMessageReceived: ((profileId: string, text: string) => void) | null = null;

// Map of channelId → profileId for reverse lookup
let channelToProfile: Map<string, string> = new Map();

// Cache of channel name → resolved channel ID
let channelIdCache: Map<string, string> = new Map();

export function setMessageHandler(
  handler: (profileId: string, text: string) => void,
) {
  onMessageReceived = handler;
}

// Resolve a channel name or ID to a channel ID.
// If the channel doesn't exist, create it.
async function resolveChannel(nameOrId: string): Promise<string | null> {
  if (!client) return null;

  // Already a channel ID
  if (nameOrId.startsWith('C') && nameOrId.length > 8) {
    return nameOrId;
  }

  // Check cache
  const cached = channelIdCache.get(nameOrId);
  if (cached) return cached;

  const cleanName = nameOrId.replace(/^#/, '').toLowerCase();

  try {
    // Try to find existing channel
    let cursor: string | undefined;
    do {
      const result = await client.conversations.list({
        types: 'public_channel,private_channel',
        limit: 200,
        cursor,
      });
      for (const ch of result.channels || []) {
        if (ch.name === cleanName && ch.id) {
          channelIdCache.set(nameOrId, ch.id);
          // Join the channel if not already a member
          try {
            await client.conversations.join({ channel: ch.id });
          } catch {
            // Already in channel or can't join — that's fine
          }
          return ch.id;
        }
      }
      cursor = result.response_metadata?.next_cursor;
    } while (cursor);

    // Channel not found — create it
    const created = await client.conversations.create({
      name: cleanName,
    });
    const newId = created.channel?.id;
    if (newId) {
      channelIdCache.set(nameOrId, newId);
      console.log(`Slack: created channel #${cleanName} (${newId})`);
      return newId;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('name_taken')) {
      // Channel exists but we couldn't list it (permissions) — try joining by name
      try {
        // Can't join by name directly, but the channel exists
        console.error(`Slack: channel #${cleanName} exists but bot can't access it. Invite the bot to the channel.`);
      } catch {
        // ignore
      }
    } else {
      console.error(`Slack: failed to resolve channel "${nameOrId}":`, msg);
    }
  }

  return null;
}

export async function initSlack(settings: AppSettings, profiles: Profile[]) {
  stopSlack();

  if (!settings.slackEnabled || !settings.slackBotToken) return;

  client = new WebClient(settings.slackBotToken);

  // Resolve channel names/IDs and build mapping
  channelToProfile.clear();
  for (const profile of profiles) {
    if (profile.slackChannel) {
      const channelId = await resolveChannel(profile.slackChannel);
      if (channelId) {
        channelToProfile.set(channelId, profile.id);
      }
    }
  }

  // Start polling for incoming messages
  if (channelToProfile.size > 0) {
    pollForMessages();
    pollInterval = setInterval(pollForMessages, 5000);
  }
}

export function stopSlack() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  client = null;
  channelToProfile.clear();
  lastTimestamps.clear();
  channelIdCache.clear();
}

export async function postStatus(
  profile: Profile,
  status: AgentStatus,
  previousStatus: AgentStatus,
  output?: string,
) {
  if (!client || !profile.slackChannel) return;

  const channelId = await resolveChannel(profile.slackChannel);
  if (!channelId) return;

  const emoji =
    status === 'ready'
      ? ':white_check_mark:'
      : status === 'needs-input'
        ? ':warning:'
        : status === 'working'
          ? ':gear:'
          : ':black_circle:';

  const header =
    status === 'ready' && previousStatus === 'working'
      ? `${emoji} *${profile.name}* — Task completed`
      : status === 'needs-input'
        ? `${emoji} *${profile.name}* — Needs your input`
        : null;

  if (!header) return;

  // Clean and truncate the output for Slack
  let outputBlock = '';
  if (output && status === 'ready' && previousStatus === 'working') {
    // Remove control chars but keep newlines
    let cleaned = output
      .replace(/[\x00-\x09\x0B\x0C\x0E-\x1F]/g, '')
      .trim();
    // Truncate to ~3000 chars (Slack message limit is 4000)
    if (cleaned.length > 3000) {
      cleaned = '...' + cleaned.slice(-3000);
    }
    if (cleaned) {
      outputBlock = '\n```\n' + cleaned + '\n```';
    }
  }

  try {
    await client.chat.postMessage({
      channel: channelId,
      text: header + outputBlock,
      mrkdwn: true,
    });
  } catch (err) {
    console.error(`Slack post failed for ${profile.name}:`, err);
  }
}

async function pollForMessages() {
  if (!client) return;

  for (const [channel, profileId] of channelToProfile) {
    try {
      const oldest = lastTimestamps.get(channel);
      const result = await client.conversations.history({
        channel,
        limit: 10,
        ...(oldest ? { oldest } : {}),
      });

      const messages = result.messages || [];
      if (messages.length === 0) continue;

      // Update timestamp to latest message
      const latest = messages[0]?.ts;
      if (latest) {
        lastTimestamps.set(channel, latest);
      }

      // Skip on first poll (don't replay history)
      if (!oldest) continue;

      // Process new messages (newest first, reverse to get chronological)
      for (const msg of [...messages].reverse()) {
        // Skip bot messages and messages without text
        if (msg.bot_id || !msg.text) continue;
        if (msg.subtype === 'bot_message') continue;

        if (onMessageReceived) {
          onMessageReceived(profileId, msg.text);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not_allowed_token_type')) {
        console.error(`Slack: invalid token type. Use a Bot token (xoxb-...), not a User token.`);
      } else if (msg.includes('channel_not_found') || msg.includes('not_in_channel')) {
        console.error(`Slack: can't access channel ${channel}. Ensure the bot is invited.`);
      } else {
        console.error(`Slack poll failed for channel ${channel}:`, msg);
      }
    }
  }
}
