const fs = require('fs');
fetch('https://a2z-non-voip-production.up.railway.app/webhooks/telegram/PVADeals2026SecureWebhook99', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Telegram-Bot-Api-Secret-Token': 'PVADeals2026SecureWebhook99'
  },
  body: JSON.stringify({
    "update_id": 9999999,
    "message": {
      "message_id": 1000,
      "from": { "id": 1786162207, "is_bot": false, "first_name": "TestUser", "username": "testuser" },
      "chat": { "id": 1786162207, "first_name": "TestUser", "username": "testuser", "type": "private" },
      "date": 1786162207,
      "text": "/menu",
      "entities": [ { "offset": 0, "length": 5, "type": "bot_command" } ]
    }
  })
})
.then(async r => {
  console.log(r.status, r.statusText);
  console.log(await r.text());
})
.catch(console.error);
