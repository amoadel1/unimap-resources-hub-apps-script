/**
 * Seed.gs
 * Imports the content of the previous Next.js/Supabase version (supabase/schema.sql
 * and the hard-coded /official pages) so the new site starts with the same data.
 *
 * Run seedInitialData() once from the editor after setup(). It is idempotent:
 * programmes are matched by slug, collections by slug, and resources by link,
 * so running it again never creates duplicates.
 */

var SEED_PROGRAMMES_ = [
  ['bachelor-electrical-engineering-with-honours', 'Bachelor of Electrical Engineering with Honours', 'بكالوريوس الهندسة الكهربائية مع مرتبة الشرف', 'Engineering', 'Electrical engineering academic resources shared by UniMAP students.'],
  ['bachelor-mechatronic-engineering-with-honours', 'Bachelor of Mechatronic Engineering with Honours', 'بكالوريوس هندسة الميكاترونكس مع مرتبة الشرف', 'Engineering', 'Mechatronic engineering drives, notes, labs, and study resources.'],
  ['bachelor-mechanical-engineering-with-honours', 'Bachelor of Mechanical Engineering with Honours', 'بكالوريوس الهندسة الميكانيكية مع مرتبة الشرف', 'Engineering', 'Mechanical engineering academic resources and community links.'],
  ['bachelor-chemical-engineering-with-honours', 'Bachelor of Chemical Engineering with Honours', 'بكالوريوس الهندسة الكيميائية مع مرتبة الشرف', 'Engineering', 'This programme page is ready for future resources.'],
  ['bachelor-computer-engineering-with-honours', 'Bachelor of Computer Engineering with Honours', 'بكالوريوس هندسة الحاسوب مع مرتبة الشرف', 'Engineering', 'Computer engineering academic resources shared by students.'],
  ['bachelor-biomedical-electronic-engineering-with-honours', 'Bachelor of Biomedical Electronic Engineering with Honours', 'بكالوريوس هندسة الإلكترونيات الطبية الحيوية مع مرتبة الشرف', 'Engineering', 'Biomedical electronic engineering resource collections.'],
  ['faculty-electronic-engineering-technology-fkten', 'Faculty of Electronic Engineering & Technology (FKTEN)', 'كلية هندسة وتكنولوجيا الإلكترونيات (FKTEN)', 'FKTEN', 'Faculty-level electronic engineering and technology resources.'],
  ['faculty-business-communication-fpk', 'Faculty of Business & Communication (FPK)', 'كلية الأعمال والاتصال (FPK)', 'FPK', 'This faculty page is ready for future resources.']
];

// [programme slug, title, owner, intake, platform, url, notes]
var SEED_RESOURCES_ = [
  ['bachelor-electrical-engineering-with-honours', 'ABDULAZIZ OSHAISH OneDrive', 'ABDULAZIZ OSHAISH', '2020', 'OneDrive', 'https://unimapedumy-my.sharepoint.com/:f:/g/personal/s201090009-5_studentmail_unimap_edu_my/EqV_7MM7Wc5BhuwdVytE0XcBC6imJFPjOTPEzNRfF1_Zeg?e=7wdENY', ''],
  ['bachelor-electrical-engineering-with-honours', 'ABDULRAHMAN ALSHAQDARI Drive', 'ABDULRAHMAN ALSHAQDARI', '2022', 'Google Drive', 'https://drive.google.com/drive/folders/19GpBX01ekINNOIDGnKl0b2HevPh0w7_t', ''],
  ['bachelor-electrical-engineering-with-honours', 'WALEED ABDULLAH ALFUTAIH Drive', 'WALEED ABDULLAH ALFUTAIH', '2023', 'Google Drive', 'https://drive.google.com/drive/folders/1FfOIZWjQePYLjj0o5JuLYJPlRLhYqc8b', ''],
  ['bachelor-electrical-engineering-with-honours', 'ADEL HUSHAM MOHAMEDAIN Drive', 'ADEL HUSHAM MOHAMEDAIN', '2023', 'Google Drive', 'https://drive.google.com/drive/folders/1CHJnJDgs3cqo14FownuZVtShnGe9qhOY', ''],
  ['bachelor-mechatronic-engineering-with-honours', 'SAIF HASAN AL AHDAL Box', 'SAIF HASAN AL AHDAL', '2020', 'Box', 'https://app.box.com/s/2dnpvvxix2rng4v9wqi9f0gb4u72019t', ''],
  ['bachelor-mechatronic-engineering-with-honours', 'AMMAR AL MEKHLAFI Drive', 'AMMAR AL MEKHLAFI', '2020', 'Google Drive', 'https://drive.google.com/drive/u/0/folders/1qNJFPQKgjQjEc5YNQbzC5_me8_xlvcC6', ''],
  ['bachelor-mechatronic-engineering-with-honours', 'ABDULKAREEM BAGERI Drive', 'ABDULKAREEM BAGERI', '2021', 'Google Drive', 'https://drive.google.com/drive/folders/1Qz3vOFiEITbpeQa2zm8pyU-jRMP3MpVL', ''],
  ['bachelor-mechatronic-engineering-with-honours', 'AMR IBRAHIM Drive', 'AMR IBRAHIM', '2020', 'Google Drive', 'https://drive.google.com/drive/folders/1zfTpaeO1eM4NzK8GAsrba3X_-OdwXoAM', ''],
  ['bachelor-mechatronic-engineering-with-honours', 'WAHIB ISMAIL MOHAMED Drive', 'WAHIB ISMAIL MOHAMED', '2020', 'Google Drive', 'https://drive.google.com/drive/folders/14EvztpSPyIPtVmxsLamSCsFupn_UrFO4', ''],
  ['bachelor-mechatronic-engineering-with-honours', 'ABDULMALEK BAABED Drive', 'ABDULMALEK BAABED', '2024', 'Google Drive', 'https://drive.google.com/drive/folders/1slANeZqBtsqWgU80NMK9XO-c5OoObwPh', ''],
  ['bachelor-mechatronic-engineering-with-honours', 'AKRAM YASSIR Drive', 'AKRAM YASSIR', '2024', 'Google Drive', 'https://drive.google.com/drive/folders/1IzJbgBpD06dpCJIsun420ix1iAo0Z3it', ''],
  ['bachelor-mechanical-engineering-with-honours', 'Mechanical Engineering Community Drive', 'Community Drive', 'Unknown', 'Google Drive', 'https://drive.google.com/drive/mobile/folders/1JF_x67GZnezYfasKagxXDV7zdf9lHnvC', 'Shared by multiple students.'],
  ['bachelor-computer-engineering-with-honours', 'MOHAMMED SALEH Drive', 'MOHAMMED SALEH', '2023', 'Google Drive', 'https://drive.google.com/drive/folders/1lYMpBrPn8bs-XHwdeGFOaTP2mNDI-5NA', ''],
  ['bachelor-computer-engineering-with-honours', 'ALA NADHER Drive', 'ALA NADHER', '2024', 'Google Drive', 'https://drive.google.com/drive/folders/1Z1WqZDr93dmcyv7Wsac2vsPiL5FnJxlJ', ''],
  ['bachelor-biomedical-electronic-engineering-with-honours', 'Mohammed Khaled Drive', 'Mohammed Khaled', '2016', 'Google Drive', 'https://drive.google.com/drive/folders/1dkT16HnVxLwrkZuuOrGrGp7tg2FEMMJo', ''],
  ['bachelor-biomedical-electronic-engineering-with-honours', 'RAMZI KHAN Drive', 'RAMZI KHAN', '2018', 'Google Drive', 'https://drive.google.com/drive/folders/13S26zFVlDyez-R84GtBkYeN_2QIgXifq', ''],
  ['bachelor-biomedical-electronic-engineering-with-honours', 'AHMED & METEB & MUSAAB Drive', 'AHMED & METEB & MUSAAB', '2019', 'Google Drive', 'https://drive.google.com/drive/folders/1RJopRh6Mi4sfNAP6iunEDtSJf10YfU3t', ''],
  ['bachelor-biomedical-electronic-engineering-with-honours', 'MARWAN ALI HASAN Drive', 'MARWAN ALI HASAN', '2021', 'Google Drive', 'https://drive.google.com/drive/folders/1xT9K3FdwgVW5EWRCD3SECZxiKY0BKd3L', ''],
  ['bachelor-biomedical-electronic-engineering-with-honours', 'AHMED BASHUMEEL Drive', 'AHMED BASHUMEEL', '2024', 'Google Drive', 'https://drive.google.com/drive/folders/1r--HXduccYeOoSsYiCOHUciFiZP40gWd', ''],
  ['faculty-electronic-engineering-technology-fkten', 'Andrew Leong Drive', 'Andrew Leong', '2022', 'Google Drive', 'https://drive.google.com/drive/folders/1_JFTgSb9I5P-IdMWjb_MU_D3LqYJCYtU', '']
];

var SEED_CATEGORIES_ = [
  ['academic-programme', 'Academic Programme', 'البرامج الأكاديمية', 'Official programme structures for each UniMAP faculty.', 'هياكل البرامج الرسمية لكل كلية في UniMAP.'],
  ['academic-courses', 'Academic Courses', 'المواد الأكاديمية', 'Official course lists published by each faculty.', 'قوائم المواد الرسمية التي تنشرها كل كلية.'],
  ['class-timetable', 'Class Timetable', 'الجدول الدراسي', 'Official class timetables for bachelor and diploma programmes.', 'الجداول الدراسية الرسمية لبرامج البكالوريوس والدبلوم.'],
  ['library-digital-services', 'Library & Digital Services', 'خدمات المكتبة والخدمات الرقمية', 'Official UniMAP library and digital services for students.', 'خدمات المكتبة والخدمات الرقمية الرسمية في UniMAP للطلاب.']
];

var UNIMAP_SITE_ = 'https://sites.google.com/unimap.edu.my/academicunimap/';

// [category slug ('' = general), title, url, notes]
var SEED_OFFICIAL_ = [
  ['', 'UniMAP Academic Guide', UNIMAP_SITE_ + 'home', 'Official UniMAP academic information including academic guide, regulations, academic calendar, timetable, forms, and academic resources.'],
  ['academic-programme', 'Faculty of Civil Engineering & Technology (FKTA)', UNIMAP_SITE_ + 'academic-programme#h.lo2rt25nv2n', 'Official programme structure.'],
  ['academic-programme', 'Faculty of Electrical Engineering & Technology (FKTE)', UNIMAP_SITE_ + 'academic-programme#h.pdax0j8nz8o', 'Official programme structure.'],
  ['academic-programme', 'Faculty of Electronic Engineering & Technology (FKTEN)', UNIMAP_SITE_ + 'academic-programme#h.syvgwrd3dui', 'Official programme structure.'],
  ['academic-programme', 'Faculty of Intelligent Computing (FKC)', UNIMAP_SITE_ + 'academic-programme#h.c0ctlj7ggbuh', 'Official programme structure.'],
  ['academic-programme', 'Faculty of Chemical Engineering & Technology (FKTK)', UNIMAP_SITE_ + 'academic-programme#h.aw3sydic5i9e', 'Official programme structure.'],
  ['academic-programme', 'Faculty of Mechanical Engineering & Technology (FKTM)', UNIMAP_SITE_ + 'academic-programme#h.la4axkkyfvkb', 'Official programme structure.'],
  ['academic-programme', 'Faculty of Business & Communication (FPK)', UNIMAP_SITE_ + 'academic-programme#h.vq0j6f1kyps4', 'Official programme structure.'],
  ['academic-courses', 'Faculty of Civil Engineering & Technology (FKTA)', UNIMAP_SITE_ + 'academic-courses/coursesftka', 'Official course list.'],
  ['academic-courses', 'Faculty of Electrical Engineering & Technology (FKTE)', UNIMAP_SITE_ + 'academic-courses/coursesftke', 'Official course list.'],
  ['academic-courses', 'Faculty of Electronic Engineering & Technology (FKTEN)', UNIMAP_SITE_ + 'academic-courses/coursesftken', 'Official course list.'],
  ['academic-courses', 'Faculty of Chemical Engineering & Technology (FKTK)', UNIMAP_SITE_ + 'academic-courses/coursesftkk', 'Official course list.'],
  ['academic-courses', 'Faculty of Mechanical Engineering & Technology (FKTM)', UNIMAP_SITE_ + 'academic-courses/coursesftkm', 'Official course list.'],
  ['academic-courses', 'Faculty of Business & Communication (FPK)', UNIMAP_SITE_ + 'academic-courses/coursesfsgm', 'Official course list.'],
  ['academic-courses', 'Faculty of Intelligent Computing (FIC)', UNIMAP_SITE_ + 'academic-courses/coursesfic/fic-courses-sa-20252026', 'Official course list.'],
  ['academic-courses', 'Co-Curriculum Centre', UNIMAP_SITE_ + 'academic-courses/coursesko-k', 'Official course list.'],
  ['class-timetable', 'Bachelor Degree Programmes', UNIMAP_SITE_ + 'class-timetable#h.8g9x2dbv72qb', 'Official class timetable.'],
  ['class-timetable', 'Diploma Programmes', UNIMAP_SITE_ + 'class-timetable#h.o40f0qm8u0cu', 'Official class timetable.'],
  ['library-digital-services', 'UniMAP Library – EZproxy', 'https://libguides.unimap.edu.my/ezproxyhosted', 'Access UniMAP Library subscribed electronic resources and online databases through EZproxy.'],
  ['library-digital-services', 'UniMAP Library Digital Repository (DSpace)', 'https://dspace.unimap.edu.my', 'Search and access UniMAP scholarly materials, research outputs, theses, articles, and other digital academic collections.'],
  ['library-digital-services', 'UniMAP Library – Room Reservation', 'https://unimap.libcal.com/reserve', 'Reserve available library rooms and study spaces through the UniMAP Library reservation service.']
];

function seedInitialData() {
  var email = assertEditor_();
  var result = seedInitialData_({ email: email });
  Logger.log('Seed complete: ' + JSON.stringify(result));
  return result;
}

/**
 * Adds ONLY the "Library & Digital Services" collection and its 3 official links.
 * Safe for a live site: unlike seedInitialData(), it never re-adds programmes, drives
 * or links that an admin has deliberately deleted. Idempotent (no duplicates).
 */
function seedLibraryDigitalServices() {
  var email = assertEditor_();
  var result = seedInitialData_({ email: email }, { onlyCategories: ['library-digital-services'] });
  Logger.log('Library & Digital Services seed complete: ' + JSON.stringify(result));
  return result;
}

/**
 * opts.onlyCategories (optional): seed just these official collections and their links;
 * programmes and student drives are skipped. Without it, everything is seeded.
 */
function seedInitialData_(actor, opts) {
  var only = opts && opts.onlyCategories ? opts.onlyCategories : null;
  var wanted = function (slug) { return !only || only.indexOf(slug) !== -1; };
  return withLock_(function () {
    var now = nowIso_();
    var result = { programmes: 0, categories: 0, resources: 0, official: 0, skipped: 0 };

    // Programmes
    var progBySlug = {};
    db_rows_('Programmes').forEach(function (p) { progBySlug[p.slug] = p; });
    var sort = nextSortOrder_('Programmes');
    var newProgs = [];
    SEED_PROGRAMMES_.forEach(function (row) {
      if (only) return;
      if (progBySlug[row[0]]) { result.skipped++; return; }
      var p = {
        id: newId_(SCHEMA.Programmes.prefix), slug: row[0], code: '', name: row[1], name_ar: row[2],
        faculty: row[3], description: row[4], description_ar: '', is_active: true, sort_order: sort,
        created_at: now, updated_at: now, created_by: actor.email, updated_by: actor.email
      };
      sort += 10;
      newProgs.push(p);
      progBySlug[p.slug] = p;
    });
    db_insertMany_('Programmes', newProgs);
    result.programmes = newProgs.length;

    // Collections
    var catBySlug = {};
    db_rows_('Categories').forEach(function (c) { catBySlug[c.slug] = c; });
    var csort = nextSortOrder_('Categories');
    var newCats = [];
    SEED_CATEGORIES_.forEach(function (row) {
      if (!wanted(row[0])) return;
      if (catBySlug[row[0]]) { result.skipped++; return; }
      var c = {
        id: newId_(SCHEMA.Categories.prefix), slug: row[0], name: row[1], name_ar: row[2],
        description: row[3], description_ar: row[4], is_active: true, sort_order: csort,
        created_at: now, updated_at: now
      };
      csort += 10;
      newCats.push(c);
      catBySlug[c.slug] = c;
    });
    db_insertMany_('Categories', newCats);
    result.categories = newCats.length;

    // Resources (dedupe by normalised link within the same programme / collection)
    var existingKeys = {};
    db_rows_('Resources').forEach(function (r) {
      existingKeys[r.url_key + '|' + (r.is_official ? 'o:' + r.category_id : 'p:' + r.programme_id)] = true;
    });
    var newRes = [];
    var rsort = 10;
    SEED_RESOURCES_.forEach(function (row) {
      if (only) return;
      var prog = progBySlug[row[0]];
      if (!prog) { result.skipped++; return; }
      var u = validateUrl_(row[5]);
      var k = u.key + '|p:' + prog.id;
      if (existingKeys[k]) { result.skipped++; return; }
      existingKeys[k] = true;
      newRes.push({
        id: newId_(SCHEMA.Resources.prefix), programme_id: prog.id, category_id: '', title: row[1],
        owner_name: row[2], intake: row[3], platform: row[4], url: u.url, url_key: u.key, notes: row[6],
        is_official: false, is_active: true, sort_order: 0, source_submission_id: '',
        created_at: now, updated_at: now, created_by: actor.email, updated_by: actor.email
      });
      result.resources++;
    });
    SEED_OFFICIAL_.forEach(function (row) {
      if (only && !(row[0] && wanted(row[0]))) return;
      var cat = row[0] ? catBySlug[row[0]] : null;
      if (row[0] && !cat) { result.skipped++; return; } // collection missing: never create an uncategorised copy
      var catId = cat ? cat.id : '';
      var u = validateUrl_(row[2]);
      var k = u.key + '|o:' + catId;
      if (existingKeys[k]) { result.skipped++; return; }
      existingKeys[k] = true;
      newRes.push({
        id: newId_(SCHEMA.Resources.prefix), programme_id: '', category_id: catId, title: row[1],
        owner_name: 'Universiti Malaysia Perlis', intake: 'Official', platform: 'Website', url: u.url, url_key: u.key,
        notes: row[3], is_official: true, is_active: true, sort_order: rsort,
        created_at: now, updated_at: now, created_by: actor.email, updated_by: actor.email
      });
      rsort += 10;
      result.official++;
    });
    db_insertMany_('Resources', newRes);
    logActivity_(actor, 'system.seed', 'system', '', JSON.stringify(result));
    invalidatePublicCache_();
    return result;
  });
}
