const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'db.json');

const DEFAULT_LETTER_TEMPLATE = `{date}

{owner}
{address}

Re: Parcel #{parcel_number} - {county} County

Dear {owner},

Public records show the property at {address} (Parcel #{parcel_number}) may be behind on property taxes (approximately \${taxes_owed} owed). I am a local investor and I buy properties in as-is condition for cash, often closing quickly and covering standard closing costs.

If you'd be open to discussing a fair cash offer before this property proceeds further through the tax foreclosure process, I'd welcome a conversation. There is no obligation.

You can reach me at [YOUR PHONE] or [YOUR EMAIL].

Sincerely,
[YOUR NAME]`;

const DEFAULT_DB = {
  counties: [],
  properties: [],
  contacts: [],
  letterTemplate: DEFAULT_LETTER_TEMPLATE,
  weeklyRoutine: {
    lastReset: null,
    checked: {}
  }
};

function ensureDataDir() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readDB() {
  ensureDataDir();
  if (!fs.existsSync(DB_PATH)) {
    writeDB(DEFAULT_DB);
    return JSON.parse(JSON.stringify(DEFAULT_DB));
  }
  const raw = fs.readFileSync(DB_PATH, 'utf8');
  const parsed = JSON.parse(raw || '{}');
  return { ...JSON.parse(JSON.stringify(DEFAULT_DB)), ...parsed };
}

function writeDB(db) {
  ensureDataDir();
  const tmpPath = DB_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(db, null, 2));
  fs.renameSync(tmpPath, DB_PATH);
}

module.exports = { readDB, writeDB, DEFAULT_LETTER_TEMPLATE };
