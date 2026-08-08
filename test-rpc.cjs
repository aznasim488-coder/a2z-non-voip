const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const env = fs.readFileSync('.env', 'utf8');
const getVar = k => env.split('\n').find(l => l.startsWith(k))?.split('=')[1]?.trim();

const supabase = createClient(getVar('SUPABASE_URL'), getVar('SUPABASE_SERVICE_ROLE_KEY'));

supabase.rpc('upsert_telegram_user', {
  p_telegram_id: 1,
  p_username: 'test',
  p_first_name: 'test',
  p_last_name: 'test'
}).then(console.log).catch(console.error);
