/**
 * Platforms.gs
 * Editable list of link platforms (Google Drive, OneDrive, Box, Telegram, ...).
 * Resources store the platform NAME so the sheet stays human-readable; renaming a
 * platform updates every resource and submission that uses it.
 */

function platformByName_(name, activeOnly) {
  var n = cleanLine_(name).toLowerCase();
  if (!n) return null;
  var rows = db_rows_('Platforms');
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].name.toLowerCase() === n && (!activeOnly || rows[i].is_active)) return rows[i];
  }
  return null;
}

function platformSave_(admin, p) {
  return withLock_(function () {
    var existing = p.id ? db_get_('Platforms', p.id) : null;
    if (p.id && !existing) throw appError_('NOT_FOUND', 'This platform no longer exists. Please refresh.');
    var name = field_(p.name, 'name', { label: 'Platform name', required: true, min: 2, max: 40 });
    db_rows_('Platforms').forEach(function (r) {
      if (r.id !== (existing && existing.id) && r.name.toLowerCase() === name.toLowerCase()) {
        throw appError_('DUPLICATE', 'This platform already exists.', 'name');
      }
    });
    var now = nowIso_();
    var active = p.is_active === undefined ? true : toBool_(p.is_active);
    if (existing) {
      var oldName = existing.name;
      if (!active && existing.is_active) platformEnsureAnotherActive_(existing.id);
      db_update_('Platforms', existing.id, { name: name, is_active: active, updated_at: now });
      var cascaded = 0;
      if (oldName !== name) cascaded = platformRenameCascade_(oldName, name);
      logActivity_(admin, 'platform.update', 'platform', existing.id,
        oldName === name ? name : ('Renamed "' + oldName + '" → "' + name + '" (' + cascaded + ' records updated)'));
      return { id: existing.id };
    }
    var created = db_insert_('Platforms', {
      id: newId_(SCHEMA.Platforms.prefix), name: name, is_active: active,
      sort_order: nextSortOrder_('Platforms'), created_at: now, updated_at: now
    });
    logActivity_(admin, 'platform.create', 'platform', created.id, name);
    return { id: created.id };
  });
}

function platformRenameCascade_(oldName, newName) {
  var count = 0;
  var resChanges = {};
  db_rows_('Resources').forEach(function (r) { if (r.platform === oldName) { resChanges[r.id] = newName; count++; } });
  if (Object.keys(resChanges).length) db_updateColumn_('Resources', 'platform', resChanges);
  var subChanges = {};
  db_rows_('Submissions').forEach(function (s) { if (s.platform === oldName) { subChanges[s.id] = newName; count++; } });
  if (Object.keys(subChanges).length) db_updateColumn_('Submissions', 'platform', subChanges);
  return count;
}

function platformEnsureAnotherActive_(id) {
  var others = db_rows_('Platforms').filter(function (r) { return r.id !== id && r.is_active; });
  if (!others.length) throw appError_('IN_USE', 'At least one platform must stay active.');
}

function platformSetActive_(admin, p) {
  return withLock_(function () {
    var existing = db_get_('Platforms', p.id);
    if (!existing) throw appError_('NOT_FOUND', 'This platform no longer exists. Please refresh.');
    var active = toBool_(p.is_active);
    if (!active) platformEnsureAnotherActive_(existing.id);
    db_update_('Platforms', existing.id, { is_active: active, updated_at: nowIso_() });
    logActivity_(admin, active ? 'platform.activate' : 'platform.deactivate', 'platform', existing.id, existing.name);
    return { id: existing.id };
  });
}

function platformDelete_(admin, p) {
  return withLock_(function () {
    var existing = db_get_('Platforms', p.id);
    if (!existing) throw appError_('NOT_FOUND', 'This platform no longer exists. Please refresh.');
    var used = db_rows_('Resources').filter(function (r) { return r.platform === existing.name; }).length;
    var pending = db_rows_('Submissions').filter(function (s) { return s.status === 'pending' && s.platform === existing.name; }).length;
    if (used || pending) {
      throw appError_('IN_USE', 'This platform is used by ' + used + ' resource(s) and ' + pending +
        ' pending submission(s). Deactivate it instead, or rename it.');
    }
    if (existing.is_active) platformEnsureAnotherActive_(existing.id);
    db_delete_('Platforms', existing.id);
    logActivity_(admin, 'platform.delete', 'platform', existing.id, existing.name);
    return { id: existing.id };
  });
}
