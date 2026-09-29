/**
 * Categories.gs
 * Collections that group OFFICIAL resources on the public site
 * (e.g. "Academic Programme", "Academic Courses", "Class Timetable").
 * They replace the hard-coded /official/... pages of the previous version.
 */

function categoryClean_(p, selfId) {
  var name = field_(p.name, 'name', { label: 'Name', required: true, min: 2, max: 120 });
  var nameAr = field_(p.name_ar, 'name_ar', { label: 'Arabic name', max: 120 });
  var description = field_(p.description, 'description', { label: 'Description', max: 800, multiline: true });
  var descriptionAr = field_(p.description_ar, 'description_ar', { label: 'Arabic description', max: 800, multiline: true });
  var slug = slugify_(p.slug || '') || slugify_(name) || ('collection-' + newId_('').slice(0, 6));
  var others = db_rows_('Categories').filter(function (r) { return r.id !== selfId; });
  others.forEach(function (r) {
    if (r.name.toLowerCase() === name.toLowerCase()) throw appError_('DUPLICATE', 'A collection with this name already exists.', 'name');
  });
  others.forEach(function (r) {
    if (r.slug === slug) throw appError_('DUPLICATE', 'Another collection already uses the URL name "' + slug + '".', 'slug');
  });
  return {
    name: name, name_ar: nameAr, description: description, description_ar: descriptionAr, slug: slug,
    is_active: p.is_active === undefined ? true : toBool_(p.is_active)
  };
}

function categorySave_(admin, p) {
  return withLock_(function () {
    var existing = p.id ? db_get_('Categories', p.id) : null;
    if (p.id && !existing) throw appError_('NOT_FOUND', 'This collection no longer exists. Please refresh.');
    var clean = categoryClean_(p, existing ? existing.id : null);
    var now = nowIso_();
    clean.updated_at = now;
    if (existing) {
      var saved = db_update_('Categories', existing.id, clean);
      logActivity_(admin, 'category.update', 'category', saved.id, saved.name);
      return { id: saved.id };
    }
    clean.id = newId_(SCHEMA.Categories.prefix);
    clean.sort_order = nextSortOrder_('Categories');
    clean.created_at = now;
    var created = db_insert_('Categories', clean);
    logActivity_(admin, 'category.create', 'category', created.id, created.name);
    return { id: created.id };
  });
}

function categorySetActive_(admin, p) {
  return withLock_(function () {
    var existing = db_get_('Categories', p.id);
    if (!existing) throw appError_('NOT_FOUND', 'This collection no longer exists. Please refresh.');
    var active = toBool_(p.is_active);
    db_update_('Categories', existing.id, { is_active: active, updated_at: nowIso_() });
    logActivity_(admin, active ? 'category.activate' : 'category.deactivate', 'category', existing.id, existing.name);
    return { id: existing.id };
  });
}

function categoryDelete_(admin, p) {
  return withLock_(function () {
    var existing = db_get_('Categories', p.id);
    if (!existing) throw appError_('NOT_FOUND', 'This collection no longer exists. Please refresh.');
    var used = db_rows_('Resources').filter(function (r) { return r.category_id === existing.id; }).length;
    if (used) {
      throw appError_('IN_USE', 'This collection still contains ' + used + ' link(s). Move or delete them first — or deactivate the collection.');
    }
    db_delete_('Categories', existing.id);
    logActivity_(admin, 'category.delete', 'category', existing.id, existing.name);
    return { id: existing.id };
  });
}
