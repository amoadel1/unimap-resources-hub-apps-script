/**
 * Admins.gs
 * Admin account management (owner only) and own-profile updates.
 */

function activeOwners_(excludeId) {
  return db_rows_('Admins').filter(function (a) {
    return a.role === 'owner' && a.is_active && a.id !== excludeId;
  });
}

function adminSave_(admin, p) {
  var name = field_(p.name, 'name', { label: 'Name', required: true, min: 2, max: 120 });
  var role = String(p.role || 'admin');
  if (!ROLES[role]) throw appError_('INVALID_OPTION', 'Invalid role.', 'role');
  var active = p.is_active === undefined ? true : toBool_(p.is_active);

  return withLock_(function () {
    var now = nowIso_();
    if (p.id) {
      var existing = db_get_('Admins', p.id);
      if (!existing) throw appError_('NOT_FOUND', 'This admin no longer exists. Please refresh.');
      if (existing.id === admin.id && (role !== existing.role || !active)) {
        throw appError_('FORBIDDEN', 'You cannot change your own role or deactivate your own account.');
      }
      if (existing.role === 'owner' && existing.is_active && (role !== 'owner' || !active) && !activeOwners_(existing.id).length) {
        throw appError_('FORBIDDEN', 'There must always be at least one active owner.');
      }
      var saved = db_update_('Admins', existing.id, { name: name, role: role, is_active: active, updated_at: now });
      var changes = [];
      if (existing.role !== role) changes.push('role ' + existing.role + ' → ' + role);
      if (existing.is_active !== active) changes.push(active ? 'activated' : 'deactivated');
      if (existing.name !== name) changes.push('renamed');
      logActivity_(admin, 'admin.update', 'admin', saved.id, saved.email + (changes.length ? ' — ' + changes.join(', ') : ''));
      return { id: saved.id };
    }

    var email = validateEmail_(p.email, 'email');
    if (findAdminByEmail_(email)) throw appError_('DUPLICATE', 'An admin with this email already exists.', 'email');
    var temp = tempPassword_();
    var created = db_insert_('Admins', {
      id: newId_(SCHEMA.Admins.prefix), name: name, email: email, role: role, is_active: active,
      password_hash: hashPassword_(temp), must_change_password: true, password_changed_at: now,
      created_at: now, updated_at: now, last_login: '', created_by: admin.email
    });
    logActivity_(admin, 'admin.create', 'admin', created.id, email + ' (' + role + ')');
    // The temporary password is shown ONCE to the owner so they can pass it on privately.
    return { id: created.id, temp_password: temp };
  });
}

function adminResetPassword_(admin, p) {
  return withLock_(function () {
    var existing = db_get_('Admins', p.id);
    if (!existing) throw appError_('NOT_FOUND', 'This admin no longer exists. Please refresh.');
    if (existing.id === admin.id) throw appError_('FORBIDDEN', 'Use "My account" to change your own password.');
    var temp = tempPassword_();
    db_update_('Admins', existing.id, {
      password_hash: hashPassword_(temp), must_change_password: true,
      password_changed_at: nowIso_(), updated_at: nowIso_()
    });
    logActivity_(admin, 'admin.reset_password', 'admin', existing.id, existing.email);
    return { id: existing.id, temp_password: temp };
  });
}

function adminDelete_(admin, p) {
  return withLock_(function () {
    var existing = db_get_('Admins', p.id);
    if (!existing) throw appError_('NOT_FOUND', 'This admin no longer exists. Please refresh.');
    if (existing.id === admin.id) throw appError_('FORBIDDEN', 'You cannot delete your own account.');
    if (existing.role === 'owner' && existing.is_active && !activeOwners_(existing.id).length) {
      throw appError_('FORBIDDEN', 'There must always be at least one active owner.');
    }
    db_delete_('Admins', existing.id);
    logActivity_(admin, 'admin.delete', 'admin', existing.id, existing.email);
    return { id: existing.id };
  });
}

function accountUpdateProfile_(admin, p) {
  var name = field_(p.name, 'name', { label: 'Name', required: true, min: 2, max: 120 });
  return withLock_(function () {
    var saved = db_update_('Admins', admin.id, { name: name, updated_at: nowIso_() });
    logActivity_(admin, 'admin.profile', 'admin', saved.id, 'Updated own profile');
    return { admin: publicAdmin_(saved) };
  });
}
