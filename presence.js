// Show friends the regular (phone) Bitmoji instead of the laptop icon while in a chat.
//
// Snapchat Web builds its presence service with a hardcoded isWeb=true
// (`new PresenceService(userId, !0, transport, ...)`, which runs `this.isWeb = r`), and
// every presence message it sends carries senderPlatform = isWeb ? WEB : MOBILE.
// Receivers pick the laptop icon or the Bitmoji from that one field.
//
// This runs in the page's world before Snapchat's bundle and catches that one
// assignment: the first `this.isWeb = true` on an object that already has
// localUserId (the presence service) gets stored as false. Nothing else changes:
// the presence-metrics collector (which has blizzardEventLogger) keeps its true,
// protobuf objects are literals with their own isWeb and never reach this setter,
// and no browser built-ins are replaced.
(() => {
  const desc = {
    configurable: true,
    enumerable: false,
    get() { return undefined; },
    set(v) {
      const isPresenceService = v === true
        && Object.prototype.hasOwnProperty.call(this, "localUserId")
        && !Object.prototype.hasOwnProperty.call(this, "blizzardEventLogger");
      Object.defineProperty(this, "isWeb", {
        value: isPresenceService ? false : v,
        writable: true, enumerable: true, configurable: true,
      });
    },
  };
  Object.defineProperty(Object.prototype, "isWeb", desc);
})();
