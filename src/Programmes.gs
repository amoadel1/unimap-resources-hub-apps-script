/**
 * Programmes.gs
 * Academic programmes (and faculty-level collections) that group student resources.
 */

function nextSortOrder_(table) {
  var max = 0;
  db_rows_(table).forEach(function (r) { if (r.sort_order > max) max = r.sort_order; });
  return Math.floor(max / 10) * 10 + 10;
}

/** Re-numbers sort_order for the given ID order with one column write. */
function reorder_(admin, table, ids, entityType) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 5000) throw appError_('VALIDATION', 'Invalid order.');
  return withLock_(function () {
    var rows = db_rows_(table);
    var known = {};
    rows.forEach(function (r) { known[r.id] = r; });
    var seen = {};
    var changes = {};
    var n = 10;
    ids.forEach(function (id) {
      id = String(id);
      if (!known[id] || seen[id]) throw appError_('VALIDATION', 'The list changed. Please refresh and try again.');
      seen[id] = 1;
      if (known[id].sort_order !== n) changes[id] = n;
      n += 10;
    });
    // Items not included keep their relative order after the listed ones.
    rows.filter(function (r) { return !seen[r.id]; })
      .sort(function (a, b) { return a.sort_order - b.sort_order; })
      .forEach(function (r) { if (r.sort_order !== n) changes[r.id] = n; n += 10; });
    if (Object.keys(changes).length) {
      db_updateColumn_(table, 'sort_order', changes);
      logActivity_(admin, entityType + '.reorder', entityType, '', 'Reordered ' + ids.length + ' items');
    }
    return { changed: Object.keys(changes).length };
  });
}

function programmeClean_(p, selfId) {
  var name = field_(p.name, 'name', { label: 'Programme name', required: true, min: 3, max: 160 });
  var nameAr = field_(p.name_ar, 'name_ar', { label: 'Arabic name', max: 160 });
  var code = field_(p.code, 'code', { label: 'Code', max: 24 }).toUpperCase();
  if (code && !/^[A-Z0-9][A-Z0-9 ._\-\/]*$/.test(code)) {
    throw appError_('VALIDATION', 'Code may contain only letters, numbers, spaces and . _ - /', 'code');
  }
  var faculty = field_(p.faculty, 'faculty', { label: 'Faculty', max: 160 });
  var description = field_(p.description, 'description', { label: 'Description', max: 1200, multiline: true });
  var descriptionAr = field_(p.description_ar, 'description_ar', { label: 'Arabic description', max: 1200, multiline: true });
  var slug = slugify_(p.slug || '') || slugify_(name) || slugify_(code);
  if (!slug) slug = 'programme-' + newId_('').slice(0, 6);
  if (slug.length < 2) throw appError_('VALIDATION', 'Please provide a valid URL name (slug).', 'slug');

  var others = db_rows_('Programmes').filter(function (r) { return r.id !== selfId; });
  others.forEach(function (r) {
    if (r.name.toLowerCase() === name.toLowerCase()) throw appError_('DUPLICATE', 'A programme with this name already exists.', 'name');
  });
  others.forEach(function (r) {
    if (code && r.code && r.code.toUpperCase() === code) throw appError_('DUPLICATE', 'Another programme already uses code ' + code + '.', 'code');
    if (r.slug === slug) throw appError_('DUPLICATE', 'Another programme already uses the URL name "' + slug + '".', 'slug');
  });

  return {
    name: name, name_ar: nameAr, code: code, faculty: faculty,
    description: description, description_ar: descriptionAr, slug: slug,
    is_active: p.is_active === undefined ? true : toBool_(p.is_active)
  };
}

function programmeSave_(admin, p) {
  return withLock_(function () {
    var existing = p.id ? db_get_('Programmes', p.id) : null;
    if (p.id && !existing) throw appError_('NOT_FOUND', 'This programme no longer exists. Please refresh.');
    var clean = programmeClean_(p, existing ? existing.id : null);
    var now = nowIso_();
    if (existing) {
      if (p.sort_order !== undefined && p.sort_order !== '') clean.sort_order = toNum_(p.sort_order, existing.sort_order);
      clean.updated_at = now;
      clean.updated_by = admin.email;
      var changed = Object.keys(clean).filter(function (k) {
        return k !== 'updated_at' && k !== 'updated_by' && String(existing[k]) !== String(clean[k]);
      });
      var saved = db_update_('Programmes', existing.id, clean);
      logActivity_(admin, 'programme.update', 'programme', saved.id, saved.name + (changed.length ? ' — changed: ' + changed.join(', ') : ''));
      return { id: saved.id };
    }
    clean.id = newId_(SCHEMA.Programmes.prefix);
    clean.sort_order = (p.sort_order !== undefined && p.sort_order !== '') ? toNum_(p.sort_order, 0) : nextSortOrder_('Programmes');
    clean.created_at = now;
    clean.updated_at = now;
    clean.created_by = admin.email;
    clean.updated_by = admin.email;
    var created = db_insert_('Programmes', clean);
    logActivity_(admin, 'programme.create', 'programme', created.id, created.name);
    return { id: created.id };
  });
}

function programmeSetActive_(admin, p) {
  return withLock_(function () {
    var existing = db_get_('Programmes', p.id);
    if (!existing) throw appError_('NOT_FOUND', 'This programme no longer exists. Please refresh.');
    var active = toBool_(p.is_active);
    db_update_('Programmes', existing.id, { is_active: active, updated_at: nowIso_(), updated_by: admin.email });
    logActivity_(admin, active ? 'programme.activate' : 'programme.deactivate', 'programme', existing.id, existing.name);
    return { id: existing.id };
  });
}

/**
 * Deletes a programme only when nothing depends on it. Otherwise the admin is
 * asked to move/delete its resources first, or simply deactivate it. This avoids
 * orphaned resources (a problem in the previous version).
 */
function programmeDelete_(admin, p) {
  return withLock_(function () {
    var existing = db_get_('Programmes', p.id);
    if (!existing) throw appError_('NOT_FOUND', 'This programme no longer exists. Please refresh.');
    var resCount = db_rows_('Resources').filter(function (r) { return r.programme_id === existing.id; }).length;
    var pendingCount = db_rows_('Submissions').filter(function (s) {
      return s.programme_id === existing.id && s.status === 'pending';
    }).length;
    if (resCount || pendingCount) {
      throw appError_('IN_USE', 'This programme still has ' + resCount + ' resource(s) and ' + pendingCount +
        ' pending submission(s). Move or delete them first — or deactivate the programme instead.');
    }
    db_delete_('Programmes', existing.id);
    logActivity_(admin, 'programme.delete', 'programme', existing.id, existing.name);
    return { id: existing.id };
  });
}
