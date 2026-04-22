const mongoose = require("mongoose");

// ---------------------------------------------------------------------------
// Course Model — IIT (ISM) Dhanbad canonical course catalogue.
//
// Seeded by bookswap-ai/scripts/seed_courses.py from data/courses.json
// (1,570 courses across 17 departments, scraped from the NEP 2024-25
// catalogue PDFs on people.iitism.ac.in).
//
// Read-only from the Node app's perspective — this collection is authored
// externally and refreshed only when IIT ISM updates the catalogue.
//
// Used by:
//   - GET /api/courses?dept=CODE → feeds course dropdown on PDF/book upload
//   - views/pdfs/new.ejs + views/books/new.ejs
//   - Python find_course_related_notes() uses codes like MCC510 to match
//     course-tagged PDFs to a curriculum lecture plan.
// ---------------------------------------------------------------------------

const courseSchema = new mongoose.Schema({
    code: {
        type: String,            // e.g. "MCC510", "MCO502", "CSE301"
        required: true,
        unique: true,
        trim: true,
        uppercase: true
    },
    name: {
        type: String,            // e.g. "Operating Systems"
        required: true,
        trim: true
    },
    ltp: {
        type: String,            // "3-0-0", "0-0-2", "0-0-0 (36)" etc.
        default: ""
    },
    // Course type as printed in the catalogue. Most are "Theory" or
    // "Practical"; a small tail is "Modular", "Audit", or blank (thesis /
    // project courses). The /api/courses endpoint normalises blanks from
    // the course name before serving to clients.
    course_type: {
        type: String,
        default: ""
    },
    department: {
        type: String,            // e.g. "Mathematics and Computing"
        required: true,
        trim: true
    },
    department_code: {
        type: String,            // e.g. "MC", "CSE", "ECE"
        required: true,
        trim: true,
        uppercase: true
    }
}, {
    // No timestamps — this is external reference data, not user-authored.
    // created_at lives on the snapshot in bookswap-ai/data/courses.json.
    collection: "courses"
});

courseSchema.index({ department_code: 1 });
courseSchema.index({ name: "text" });

module.exports = mongoose.model("Course", courseSchema);
