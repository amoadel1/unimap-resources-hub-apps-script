/**
 * Admin.gs
 * Single, authorised entry point for every dashboard operation.
 *
 * The browser calls adminApi(token, action, payload) (see Code.gs). For EVERY call:
 *   1. the session token is verified and the admin row is re-read from the sheet;
 *   2. the action must exist in the allow-list below;
 *   3. the admin's CURRENT role must meet the action's minimum role;
 *   4. admins who must change their password can do nothing else first.
 * Client-side role checks only hide buttons; they are never trusted.
 */

function adminActions_() {
  return {
    'session.me':              { role: 'reviewer', fn: function (a) { return { admin: publicAdmin_(a) }; }, preAuth: true },
    'account.changePassword':  { role: 'reviewer', fn: changeOwnPassword_, preAuth: true },
    'account.updateProfile':   { role: 'reviewer', fn: accountUpdateProfile_ },
    'bootstrap':               { role: 'reviewer', fn: adminBootstrap_ },

    'programmes.save':         { role: 'admin', fn: programmeSave_ },
    'programmes.setActive':    { role: 'admin', fn: programmeSetActive_ },
    'programmes.delete':       { role: 'admin', fn: programmeDelete_ },
    'programmes.reorder':      { role: 'admin', fn: function (a, p) { return reorder_(a, 'Programmes', p.ids, 'programme'); } },

    'categories.save':         { role: 'admin', fn: categorySave_ },
    'categories.setActive':    { role: 'admin', fn: categorySetActive_ },
    'categories.delete':       { role: 'admin', fn: categoryDelete_ },
    'categories.reorder':      { role: 'admin', fn: function (a, p) { return reorder_(a, 'Categories', p.ids, 'category'); } },

    'platforms.save':          { role: 'admin', fn: platformSave_ },
    'platforms.setActive':     { role: 'admin', fn: platformSetActive_ },
    'platforms.delete':        { role: 'admin', fn: platformDelete_ },
    'platforms.reorder':       { role: 'admin', fn: function (a, p) { return reorder_(a, 'Platforms', p.ids, 'platform'); } },

    'resources.save':          { role: 'admin', fn: resourceSave_ },
    'resources.setActive':     { role: 'admin', fn: resourceSetActive_ },
    'resources.delete':        { role: 'admin', fn: resourceDelete_ },
    'resources.bulk':          { role: 'admin', fn: resourceBulk_ },

    'submissions.approve':     { role: 'reviewer', fn: submissionApprove_ },
    'submissions.reject':      { role: 'reviewer', fn: submissionReject_ },
    'submissions.saveNotes':   { role: 'reviewer', fn: submissionSaveNotes_ },
    'submissions.reopen':      { role: 'admin', fn: submissionReopen_ },
    'submissions.delete':      { role: 'admin', fn: submissionDelete_ },

    'admins.save':             { role: 'owner', fn: adminSave_ },
    'admins.resetPassword':    { role: 'owner', fn: adminResetPassword_ },
    'admins.delete':           { role: 'owner', fn: adminDelete_ },

    'settings.save':           { role: 'admin', fn: settingsSave_ },
    'activity.list':           { role: 'reviewer', fn: activityList_ },
    'analytics.summary':       { role: 'admin', fn: function (a, p) { return analyticsSummary_(a, p); } },
    'system.health':           { role: 'owner', fn: function () { return validateStructure_(); } },
    'system.clearCache':       { role: 'owner', fn: function (a) {
      invalidatePublicCache_();
      logActivity_(a, 'system.clear_cache', 'system', '', 'Cleared public cache');
      return { cleared: true };
    } }
  };
}

function adminDispatch_(token, action, payload) {
  delta_begin_();
  try {
    var admin = requireSession_(token);
    var actions = adminActions_();
    if (typeof action !== 'string' || !Object.prototype.hasOwnProperty.call(actions, action)) {
      throw appError_('NOT_FOUND', 'Unknown action.');
    }
    var def = actions[action];
    if (admin.must_change_password && !def.preAuth) {
      throw appError_('PASSWORD_CHANGE_REQUIRED', 'Please change your temporary password first.');
    }
    requireRole_(admin, def.role);
    var data = def.fn(admin, isPlainObject_(payload) ? payload : {});
    return { ok: true, data: data, delta: serializeDelta_(admin) };
  } catch (e) {
    return errorResponse_(e);
  } finally {
    if (delta_touchesContent_()) invalidatePublicCache_();
    DB_DELTA_ = null;
  }
}

/** Converts the change collector into browser-safe data (no password hashes). */
function serializeDelta_(admin) {
  var d = DB_DELTA_ || { upsert: {}, remove: {} };
  var out = { upsert: {}, remove: d.remove };
  Object.keys(d.upsert).forEach(function (name) {
    var list = d.upsert[name];
    if (name === 'Admins') {
      list = list.filter(function (a) { return roleAtLeast_(admin, 'owner') || a.id === admin.id; }).map(publicAdmin_);
    }
    if (name === 'Settings') return; // settings are returned in full by settings.save
    out.upsert[name] = list;
  });
  return out;
}

function byNewest_(field) {
  return function (a, b) { return String(b[field]).localeCompare(String(a[field])); };
}

/** Everything the dashboard needs, in ONE server call. */
function adminBootstrap_(admin) {
  var submissions = db_rows_('Submissions').slice().sort(byNewest_('submitted_at'));
  var pending = submissions.filter(function (s) { return s.status === 'pending'; });
  var reviewed = submissions.filter(function (s) { return s.status !== 'pending'; }).slice(0, APP.MAX_SUBMISSIONS_HISTORY);
  var totals = { pending: pending.length, approved: 0, rejected: 0 };
  submissions.forEach(function (s) { if (s.status === 'approved') totals.approved++; else if (s.status === 'rejected') totals.rejected++; });

  var admins = roleAtLeast_(admin, 'owner')
    ? db_rows_('Admins').map(publicAdmin_)
    : [publicAdmin_(admin)];

  var url = '';
  try { url = ScriptApp.getService().getUrl() || ''; } catch (e) {}

  return {
    me: publicAdmin_(admin),
    app: { name: APP.NAME, version: APP.VERSION, url: url, roles: Object.keys(ROLES) },
    programmes: db_rows_('Programmes'),
    categories: db_rows_('Categories'),
    platforms: db_rows_('Platforms'),
    resources: db_rows_('Resources'),
    submissions: pending.concat(reviewed),
    submission_totals: totals,
    admins: admins,
    settings: adminSettings_(admin),
    activity: db_tail_('ActivityLog', 100)
  };
}

function activityList_(admin, p) {
  var limit = Math.max(10, Math.min(APP.MAX_ACTIVITY_READ, toNum_(p.limit, 100)));
  return { activity: db_tail_('ActivityLog', limit) };
}
