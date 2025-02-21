const fs = require("fs");
const osa = require("osa2");
const ol = require("one-liner");
const assert = require("assert");
const macosVersion = require("macos-version");

const versions = require("./macos_versions");
const currentVersion = macosVersion();

const messagesDb = require("./lib/messages-db.js");

// Instead of doing something reasonable, Apple stores dates as the number of
// seconds since 01-01-2001 00:00:00 GMT. DATE_OFFSET is the offset in seconds
// between their epoch and unix time
const DATE_OFFSET = 978307200;

// Gets the current Apple-style timestamp
function appleTimeNow() {
  return Math.floor(Date.now() / 1000) - DATE_OFFSET;
}

// Transforms an Apple-style timestamp to a proper unix timestamp
function fromAppleTime(ts) {
  if (ts == 0) {
    return null;
  }

  // unpackTime returns 0 if the timestamp wasn't packed
  // TODO: see `packTimeConditionally`'s comment
  if (unpackTime(ts) != 0) {
    ts = unpackTime(ts);
  }

  return new Date((ts + DATE_OFFSET) * 1000);
}

// Since macOS 10.13 High Sierra, some timestamps appear to have extra data
// packed. Dividing by 10^9 seems to get an Apple-style timestamp back.
// According to a StackOverflow user, timestamps now have nanosecond precision
function unpackTime(ts) {
  return Math.floor(ts / Math.pow(10, 9));
}

// TODO: Do some kind of database-based detection rather than relying on the
// operating system version
function packTimeConditionally(ts) {
  if (macosVersion.is(">=10.13")) {
    return ts * Math.pow(10, 9);
  } else {
    return ts;
  }
}

// Gets the proper handle string for a contact with the given name
function handleForName(name) {
  assert(typeof name == "string", "name must be a string");
  return osa((name) => {
    const Messages = Application("Messages");
    return Messages.buddies.whose({ name: name })[0].handle();
  })(name);
}

// Gets the display name for a given handle
// TODO: support group chats
function nameForHandle(handle) {
  assert(typeof handle == "string", "handle must be a string");
  return osa((handle) => {
    const Messages = Application("Messages");
    return Messages.buddies.whose({ handle: handle }).name()[0];
  })(handle);
}

// Sends a message to the given handle
function send(handle, message, service = "SMS") {
  assert(typeof handle == "string", "handle must be a string");
  assert(typeof message == "string", "message must be a string");
  return osa((handle, message, service) => {
    const Messages = Application("Messages");

    let target;

    try {
      const options = Messages.buddies.whose({ handle: handle });
      let chosenIndex = 0;
      for (let index = 0; index < options.length; index++) {
        const option = options[index];
        if (option.service.name().toLowerCase() === service.toLowerCase()) {
          chosenIndex = index;
        }
      }

      target = options[chosenIndex];
    } catch (e) {}

    try {
      target = Messages.textChats.byId("iMessage;+;" + handle)();
    } catch (e) {}

    try {
      Messages.send(message, { to: target });
    } catch (e) {
      throw new Error(`no thread with handle '${handle}'`);
    }
  })(handle, message, service);
}

let emitter = null;
let emittedMsgs = [];

function listen() {
  // If listen has already been run, return the existing emitter
  if (emitter != null) {
    return emitter;
  }

  // Create an EventEmitter
  emitter = new (require("events").EventEmitter)();

  let last = packTimeConditionally(appleTimeNow() - 5);
  let bail = false;

  const dbPromise = messagesDb.open();

  console.info("Actively listening for activity... Press Control + C to quit.");

  async function check() {
    const db = await dbPromise;
    const query = `
            SELECT DISTINCT
            *,
            ct.guid as chat_handle_id
            FROM
                (
                    SELECT DISTINCT
                        CASE 
                          WHEN cache_roomnames is NULL THEN 0
                          ELSE 1
                        END as is_groupchat,
                        guid as message_guid,
                        message.ROWID as message_row_id,
                        id as handle,
                        message.service,
                        account,
                        text,
                        date,
                        date_read,
                        is_from_me,
                        cache_roomnames
                    FROM message
                    LEFT OUTER JOIN handle 
                    ON message.handle_id = handle.ROWID
                    WHERE date >= ${last}
                )

            INNER JOIN chat_message_join cj
            ON message_row_id = cj.message_id
            AND date = cj.message_date

            INNER JOIN chat ct
            on cj.chat_id = ct.ROWID


        `;
    last = packTimeConditionally(appleTimeNow());

    try {
      const messages = await db.all(query);
      messages.forEach((msg) => {
        if (emittedMsgs[msg.guid]) return;
        emittedMsgs[msg.guid] = true;
        emitter.emit("message", {
          raw: msg,
          guid: msg.message_guid,
          text: msg.text,
          handle: msg.handle,
          chatHandle: msg.chat_handle_id,
          service: msg.service === "SMS" ? msg.service : msg.account,
          group: msg.cache_roomnames,
          fromMe: !!msg.is_from_me,
          date: fromAppleTime(msg.date),
          dateRead: fromAppleTime(msg.date_read),
        });
      });
      setTimeout(check, 1000);
    } catch (err) {
      bail = true;
      emitter.emit("error", err);
      warn(`sqlite returned an error while polling for new messages!
                  bailing out of poll routine for safety. new messages will
                  not be detected`);
    }
  }

  if (bail) return;
  check();

  return emitter;
}

async function getRecentChats(limit = 10) {
  try {
    const db = await messagesDb.open();

    const query = `
        SELECT
            *
        FROM chat
        JOIN chat_handle_join ON chat_handle_join.chat_id = chat.ROWID
        JOIN handle ON handle.ROWID = chat_handle_join.handle_id
        ORDER BY chat.last_read_message_timestamp DESC
        LIMIT ${limit};
    `;

    const chats = await db.all(query);
    return chats;
  } catch (e) {
    console.log(e);
    return [];
  }
}

async function getRecentChatsFromId(id) {
  try {
    const db = await messagesDb.open();
    if (!id)
      console.error(
        "Tried requesting messages from a user which doesn't exist..."
      );

    const query = `
            SELECT
                guid,
                id as handle,
                message.service,
                account,
                text,
                date,
                date_read,
                is_from_me,
                cache_roomnames
            FROM message
            LEFT OUTER JOIN handle ON message.handle_id = handle.ROWID
            WHERE message.handle_id = ${id}
            ORDER BY message.date DESC
            LIMIT 10`;

    const recents = await db.all(query);
    return recents;
  } catch (e) {
    warn(e);
    return [];
  }
}

// get attachments for given handle_id
async function getAttachmentsFromId(id, limit = 10) {
  const db = await messagesDb.open();

  const query = `
        SELECT
            *
        FROM message
        INNER JOIN message_attachment_join ON message.ROWID = message_attachment_join.message_id
        INNER JOIN attachment ON attachment.ROWID = message_attachment_join.attachment_id
        WHERE message.handle_id = ${id}
        LIMIT ${limit}
    `;

  const attachments = await db.all(query);
  return attachments;
}

// get attachments for given handle_id
async function getRecentAttachments(limit = 10) {
  const db = await messagesDb.open();

  const query = `
        SELECT
            *
        FROM message
        INNER JOIN message_attachment_join ON message.ROWID = message_attachment_join.message_id
        INNER JOIN attachment ON attachment.ROWID = message_attachment_join.attachment_id
        LIMIT ${limit}
    `;

  const attachments = await db.all(query);
  return attachments;
}

module.exports = {
  send,
  listen,
  /*    attachentListen,*/
  handleForName,
  nameForHandle,
  getRecentChats,
  getRecentChatsFromId,
  getRecentAttachments,
  getAttachmentsFromId,
  SUPPRESS_WARNINGS: false,
};
