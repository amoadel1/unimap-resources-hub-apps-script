/**
 * Resources.gs
 * Links to external resources (student drives and official UniMAP links).
 * The hub never hosts files — it stores the original link, so when the owner
 * updates their Drive/OneDrive folder, students automatically see the latest files.
 */

/**
 * Validates resource input. Used by the admin form AND by submission approval,
 * so both paths enforce exactly the same rules.
 */
function resourceClean_(p, selfId) {
  var isOfficial = toBool_(p.is_official);
  var title = field_(p.title, 'title', { label: 'Title', required: true, min: 2, max: 180 });
  var owner = field_(p.owner_name, 'owner_name', { label: 'Owner name', required: true, min: 2, max: 140 });
  var intake = field_(p.intake, 'intake', { label: 'Intake', max: 40 });
  if (!intake) {
    if (isOfficial) intake = 'Official';
    else throw appError_('REQUIRED', 'Intake is required.', 'intake');
  }
  var platform = platformByName_(p.platform, false);
  if (!platform) throw appError_('INVALID_OPTION', 'Please choose a valid platform.', 'platform');
  var u = validateUrl_(p.url, { field: 'url' });
  var notes = field_(p.notes, 'notes', { label: 'Notes', max: 1000, multiline: true });

  var programmeId = cleanLine_(p.programme_id);
  if (programmeId && !db_get_('Programmes', programmeId)) {
    throw appError_('INVALID_OPTION', 'The selected programme does not exist.', 'programme_id');
  }
  if (!isOfficial && !programmeId) {
    throw appError_('REQUIRED', 'Student resources must belong to a programme.', 'programme_id');
  }
  var categoryId = isOfficial ? cleanLine_(p.category_id) : '';
  if (categoryId && !db_get_('Categories', categoryId)) {
    throw appError_('INVALID_OPTION', 'The selected collection does not exist.', 'category_id');
  }

  // Duplicate protection: the same link cannot be listed twice in the same place.
  db_rows_('Resources').forEach(function (r) {
    if (r.id === selfId || r.url_key !== u.key) return;
    var samePlace = isOfficial
      ? (r.is_official && r.category_id === categoryId && r.programme_id === programmeId)
      : (!r.is_official && r.programme_id === programmeId);
    if (samePlace) {
      throw appError_('DUPLICATE_RESOURCE', 'This link is already listed here as "' + r.title + '".', 'url', { title: r.title, id: r.id });
    }
  });

  return {
    title: title, owner_name: owner, intake: intake, platform: platform.name,
    url: u.url, url_key: u.key, notes: notes,
    programme_id: programmeId, category_id: categoryId,
    is_official: isOfficial,
    is_active: p.is_active === undefined ? true : toBool_(p.is_active),
    sort_order: toNum_(p.sort_order, 0)
  };
}

/** Creates a resource. Must be called inside withLock_. */
function resourceInsert_(admin, clean, sourceSubmissionId) {
  var now = nowIso_();
  clean.id = newId_(SCHEMA.Resources.prefix);
  clean.source_submission_id = sourceSubmissionId || '';
  clean.created_at = now;
  clean.updated_at = now;
  clean.created_by = admin.email;
  clean.updated_by = admin.email;
  return db_insert_('Resources', clean);
}

function resourceSave_(admin, p) {
  return withLock_(function () {
    var existing = p.id ? db_get_('Resources', p.id) : null;
    if (p.id && !existing) throw appError_('NOT_FOUND', 'This resource no longer exists. Please refresh.');
    var clean = resourceClean_(p, existing ? existing.id : null);
    if (existing) {
      var changed = Object.keys(clean).filter(function (k) { return k !== 'url_key' && String(existing[k]) !== String(clean[k]); });
      clean.updated_at = nowIso_();
      clean.updated_by = admin.email;
      var saved = db_update_('Resources', existing.id, clean);
      logActivity_(admin, 'resource.update', 'resource', saved.id, saved.title + (changed.length ? ' — changed: ' + changed.join(', ') : ''));
      return { id: saved.id };
    }
    var created = resourceInsert_(admin, clean, '');
    logActivity_(admin, 'resource.create', 'resource', created.id, created.title + (created.is_official ? ' (official)' : ''));
    return { id: created.id };
  });
}

function resourceSetActive_(admin, p) {
  return withLock_(function () {
    var existing = db_get_('Resources', p.id);
    if (!existing) throw appError_('NOT_FOUND', 'This resource no longer exists. Please refresh.');
    var active = toBool_(p.is_active);
    db_update_('Resources', existing.id, { is_active: active, updated_at: nowIso_(), updated_by: admin.email });
    logActivity_(admin, active ? 'resource.activate' : 'resource.deactivate', 'resource', existing.id, existing.title);
    return { id: existing.id };
  });
}

function resourceDelete_(admin, p) {
  return withLock_(function () {
    var existing = db_get_('Resources', p.id);
    if (!existing) throw appError_('NOT_FOUND', 'This resource no longer exists. Please refresh.');
    db_delete_('Resources', existing.id);
    logActivity_(admin, 'resource.delete', 'resource', existing.id, existing.title + ' — ' + existing.url);
    return { id: existing.id };
  });
}

/** Bulk activate / deactivate / delete for selected resources. */
function resourceBulk_(admin, p) {
  var ids = Array.isArray(p.ids) ? p.ids.map(String) : [];
  if (!ids.length || ids.length > 500) throw appError_('VALIDATION', 'Select between 1 and 500 resources.');
  var op = String(p.op || '');
  if (['activate', 'deactivate', 'delete'].indexOf(op) === -1) throw appError_('VALIDATION', 'Unknown bulk action.');
  return withLock_(function () {
    ids.forEach(function (id) {
      if (!db_get_('Resources', id)) throw appError_('NOT_FOUND', 'Some selected resources no longer exist. Please refresh.');
    });
    if (op === 'delete') {
      db_delete_('Resources', ids);
    } else {
      var changes = {};
      ids.forEach(function (id) { changes[id] = op === 'activate'; });
      db_updateColumn_('Resources', 'is_active', changes);
    }
    logActivity_(admin, 'resource.bulk_' + op, 'resource', '', op + ' ' + ids.length + ' resource(s)');
    return { count: ids.length };
  });
}
