const mongoose = require("mongoose");

// ---------------------------------------------------------------------------
// Curriculum Model — Phase 10 persistence layer
//
// One document per saved curriculum-match run. When a logged-in user uploads
// a lecture plan and we get a parsed result back from the Python service, we
// snapshot the whole thing here so the student can revisit it from their
// profile without re-uploading the PDF.
//
// Snapshot, not live:
//   We store `parsed_result` as-is at save time. If books leave/join the
//   library later, the saved view still reflects what the student saw on
//   upload day. That's intentional — it's a reproducible record, not a live
//   query. A fresh re-upload gives fresh results.
//
// We deliberately do NOT upload the lecture-plan PDF to Cloudinary. The value
// is in the match output, not the raw PDF. Keeps Cloudinary quota / bandwidth
// lean and sidesteps the 10MB free-tier cap we already hit on book uploads.
// ---------------------------------------------------------------------------

const curriculumSchema = new mongoose.Schema({
    user_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
        index: true,          // every history lookup filters by user_id
    },
    course_name: {
        type: String,
        trim: true,
        default: ""
    },
    course_code: {
        type: String,
        trim: true,
        default: ""
    },
    department: {
        type: String,
        trim: true,
        default: ""
    },
    // Original upload filename, kept only for display — e.g. "OS_MCC510.pdf"
    // shown under the saved entry. Not used for retrieval.
    pdf_filename: {
        type: String,
        default: ""
    },
    // Whole Python /curriculum response, snapshotted verbatim. Using Mixed
    // because the sub-shape has nested arrays of books / units / notes and
    // we don't want to duplicate the full schema tree here — it's a read-
    // mostly artifact rendered straight through results.ejs.
    parsed_result: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    },
    // Which curriculum-parser prompt version produced this result.
    // Useful for thesis Chapter 5 — lets us filter history by prompt_version
    // when building the ablation table without re-running the Python pipeline.
    prompt_version: {
        type: String,
        default: ""
    },
    created_at: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model("Curriculum", curriculumSchema);
