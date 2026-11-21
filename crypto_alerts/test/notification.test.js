const test = require("node:test");
const assert = require("node:assert/strict");
const notificationService = require("../services/notificationService");

test("Unit Tests - Multi-Channel Notification Service", async (t) => {
  await t.test("formatAlertMessage formats alert details properly", () => {
    const sampleAlert = {
      id: 1,
      username: "leekwan",
      asset_symbol: "BTC/USDT",
      asset_name: "Bitcoin",
      exchange_name: "OKX Singapore",
      condition_type: "ABOVE",
      target_price: 90000,
      last_d1_close: 91500,
    };
    const msg = notificationService.formatAlertMessage(sampleAlert);
    assert.ok(msg.includes("CRYPTO PRICE ALERT TRIGGERED"));
    assert.ok(msg.includes("leekwan"));
    assert.ok(msg.includes("BTC/USDT"));
    assert.ok(msg.includes("ABOVE $90,000"));
    assert.ok(msg.includes("$91,500"));
  });

  await t.test("sendTelegramAlert succeeds (simulated when no token)", async () => {
    const res = await notificationService.sendTelegramAlert("@test_chat", "Test Alert Message");
    assert.equal(res.success, true);
    assert.equal(res.channel, "TELEGRAM");
    assert.equal(res.target, "@test_chat");
  });

  await t.test("sendDiscordAlert succeeds (simulated for mock webhook)", async () => {
    const res = await notificationService.sendDiscordAlert(
      "https://discord.com/api/webhooks/mock/cico",
      "Test Discord Message",
      { assetSymbol: "ETH/USDT", conditionType: "BELOW" }
    );
    assert.equal(res.success, true);
    assert.equal(res.channel, "DISCORD");
  });

  await t.test("sendEmailAlert logs and succeeds", async () => {
    const res = await notificationService.sendEmailAlert(
      "user@example.com",
      "Alert Subject",
      "Alert Body"
    );
    assert.equal(res.success, true);
    assert.equal(res.channel, "EMAIL");
  });

  await t.test("dispatchAlertNotification routes correctly to each channel", async () => {
    const tgAlert = {
      id: 1,
      username: "leekwan",
      asset_symbol: "BTC/USDT",
      condition_type: "ABOVE",
      target_price: 88000,
      last_d1_close: 89000,
      notification_channel: "TELEGRAM",
      recipient_target: "@tg_user",
    };
    const resTg = await notificationService.dispatchAlertNotification(tgAlert);
    assert.equal(resTg.channel, "TELEGRAM");

    const emailAlert = {
      ...tgAlert,
      notification_channel: "EMAIL",
      recipient_target: "trader@example.com",
    };
    const resEmail = await notificationService.dispatchAlertNotification(emailAlert);
    assert.equal(resEmail.channel, "EMAIL");

    const appAlert = {
      ...tgAlert,
      notification_channel: "IN_APP",
    };
    const resApp = await notificationService.dispatchAlertNotification(appAlert);
    assert.equal(resApp.channel, "IN_APP");
  });

  await t.test("cryptoService encrypts, decrypts, and masks targets", () => {
    const cryptoService = require("../services/cryptoService");

    const rawDiscord = "https://discord.com/api/webhooks/12345/abcdefg";
    const encDiscord = cryptoService.encrypt(rawDiscord);
    assert.ok(encDiscord.startsWith("enc:v1:"), "Must have encrypted prefix");
    assert.notEqual(encDiscord, rawDiscord);

    const decDiscord = cryptoService.decrypt(encDiscord);
    assert.equal(decDiscord, rawDiscord, "Decryption must recover exact plaintext");

    const maskedDiscord = cryptoService.maskTarget(encDiscord);
    assert.ok(maskedDiscord.includes("https://discord.com/.../"), "Must mask sensitive webhook path");

    const rawTg = "@leekwan_vip_channel";
    const encTg = cryptoService.encrypt(rawTg);
    assert.equal(cryptoService.decrypt(encTg), rawTg);
    const maskedTg = cryptoService.maskTarget(encTg);
    assert.ok(maskedTg.includes("****"), "Must mask Telegram username");
  });

  await t.test("Quiet Hours suppression logic correctly identifies active windows", () => {
    // 1. Overnight window: 22:00 to 07:00
    // Test 23:30 (inside window)
    const lateNight = new Date("2026-11-20T23:30:00");
    assert.equal(notificationService.isWithinQuietHours("22:00:00", "07:00:00", lateNight), true);

    // Test 03:15 (inside window)
    const earlyMorning = new Date("2026-11-20T03:15:00");
    assert.equal(notificationService.isWithinQuietHours("22:00:00", "07:00:00", earlyMorning), true);

    // Test 14:00 (outside window)
    const afternoon = new Date("2026-11-20T14:00:00");
    assert.equal(notificationService.isWithinQuietHours("22:00:00", "07:00:00", afternoon), false);

    // 2. Daytime window: 09:00 to 17:00
    assert.equal(notificationService.isWithinQuietHours("09:00:00", "17:00:00", afternoon), true);
  });

  await t.test("Exponential backoff delays scale predictably", () => {
    assert.equal(notificationService.getBackoffDelaySeconds(1), 30);
    assert.equal(notificationService.getBackoffDelaySeconds(2), 120);
    assert.equal(notificationService.getBackoffDelaySeconds(3), 480);
  });
});
