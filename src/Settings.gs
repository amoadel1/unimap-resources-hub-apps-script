/**
 * Settings.gs
 * Key/value application settings stored in the "Settings" sheet.
 * Definitions (types, defaults, who may edit) live in Config.gs → SETTINGS_DEF.
 */

var SETTINGS_MEMO_ = null;

/** All settings as { key: stringValue }, merged with defaults. Cached. */
function settingsMap_() {
  if (SETTINGS_MEMO_) return SETTINGS_MEMO_;
  var cached = cacheGetJson_('settings_v1');
  if (cached) {
    SETTINGS_MEMO_ = cached;
    return cached;
  }
  var map = {};
  SETTINGS_DEF.forEach(function (d) { map[d.key] = d.default; });
  try {
    db_rows_('Settings').forEach(function (r) {
      if (settingDef_(r.key)) map[r.key] = r.value;
    });
  } catch (e) {
    if (!(e && e.appCode === 'DB_UNAVAILABLE')) throw e;
  }
  SETTINGS_MEMO_ = map;
  cachePutJson_('settings_v1', map, APP.CACHE_TTL_PUBLIC);
  return map;
}

/** Settings safe for the public website (typed). */
function publicSettings_() {
  var map = settingsMap_();
  var out = {};
  SETTINGS_DEF.forEach(function (d) {
    if (!d.public) return;
    out[d.key] = d.type === 'bool' ? toBool_(map[d.key]) :
                 d.type === 'number' ? toNum_(map[d.key], 0) : String(map[d.key] || '');
  });
  return out;
}

/** Settings + definitions for the dashboard, filtered by what the admin may see/edit. */
function adminSettings_(admin) {
  var map = settingsMap_();
  return SETTINGS_DEF.map(function (d) {
    return {
      key: d.key, type: d.type, group: d.group, description: d.description,
      options: d.options || null, max: d.max || null, min: d.min === undefined ? null : d.min,
      value: String(map[d.key] === undefined ? '' : map[d.key]),
      default_value: d.default,
      editable: roleAtLeast_(admin, d.role),
      role: d.role
    };
  });
}

function cleanSettingValue_(d, value) {
  switch (d.type) {
    case 'bool':
      return toBool_(value) ? 'TRUE' : 'FALSE';
    case 'number': {
      var n = toNum_(value, NaN);
      if (!isFinite(n)) throw appError_('INVALID_OPTION', d.key + ' must be a number.', d.key);
      if (d.min !== undefined && n < d.min) throw appError_('INVALID_OPTION', d.key + ' must be at least ' + d.min + '.', d.key);
      if (d.max !== undefined && n > d.max) throw appError_('INVALID_OPTION', d.key + ' must be at most ' + d.max + '.', d.key);
      return String(Math.round(n));
    }
    case 'email':
      return validateEmail_(value, d.key);
    case 'select':
      value = cleanLine_(value);
      if ((d.options || []).indexOf(value) === -1) throw appError_('INVALID_OPTION', 'Invalid value for ' + d.key + '.', d.key);
      return value;
    case 'longtext':
      return field_(value, d.key, { label: d.key, max: d.max || 4000, multiline: true });
    default:
      return field_(value, d.key, { label: d.key, max: d.max || 500 });
  }
}

/** Saves several settings at once with a single sheet write. */
function settingsSave_(admin, payload) {
  var values = payload.values;
  if (!isPlainObject_(values)) throw appError_('VALIDATION', 'No settings to save.');
  var clean = {};
  Object.keys(values).forEach(function (key) {
    var d = settingDef_(key);
    if (!d) throw appError_('INVALID_OPTION', 'Unknown setting: ' + key);
    if (!roleAtLeast_(admin, d.role)) throw appError_('FORBIDDEN', 'You do not have permission to change "' + key + '".');
    clean[key] = cleanSettingValue_(d, values[key]);
  });
  if (clean.site_name !== undefined && !clean.site_name) throw appError_('REQUIRED', 'Site name is required.', 'site_name');

  return withLock_(function () {
    SETTINGS_MEMO_ = null;
    cacheRemove_('settings_v1');
    var now = nowIso_();
    var current = settingsMap_();
    var changed = [];
    var inserts = [];
    Object.keys(clean).forEach(function (key) {
      var existing = db_get_('Settings', key);
      if (existing) {
        if (existing.value !== clean[key]) {
          db_update_('Settings', key, { value: clean[key], updated_at: now, updated_by: admin.email });
          changed.push(key);
        }
      } else if (current[key] !== clean[key]) {
        inserts.push({ key: key, value: clean[key], description: settingDef_(key).description, updated_at: now, updated_by: admin.email });
        changed.push(key);
      }
    });
    if (inserts.length) db_insertMany_('Settings', inserts);
    if (changed.length) logActivity_(admin, 'settings.update', 'settings', '', 'Changed: ' + changed.join(', '));
    SETTINGS_MEMO_ = null;
    invalidatePublicCache_();
    return { changed: changed, settings: adminSettings_(admin) };
  });
}
