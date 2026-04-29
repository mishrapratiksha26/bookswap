const mongoose = require("mongoose");

// ---------------------------------------------------------------------------
// Pdf Model — Digital Resource Library (Phase 9)
//
// Stores study material uploaded by professors or students:
//   textbooks, notes, previous year papers, reference material.
//
// Each document also stores:
//   - cloudinary_url: where the PDF is served from (Cloudinary)
//   - embedding: 384-dim float array for semantic search (set by Python service)
//   - chapter_headings: extracted headings for curriculum matching (Phase 10)
// ---------------------------------------------------------------------------

const pdfSchema = new mongoose.Schema({
    title: {
        type: String,
        required: true,
        trim: true
    },
    subject: {
        type: String,
        required: true,
        trim: true
    },
    course: {
        type: String,     // e.g. "CS301", "MA201"
        trim: true,
        default: ""
    },
    department: {
        type: String,     // e.g. "CSE", "Mathematics", "ECE"
        trim: true,
        default: ""
    },
    professor: {
        type: String,     // optional uploader/source name
        trim: true,
        default: ""
    },
    resource_type: {
        type: String,
        enum: ["textbook", "notes", "previous_papers", "reference"],
        default: "notes"
    },
    // Optional, resource-type-specific metadata. The upload form reveals the
    // relevant fields based on resource_type; blanks are fine for resources
    // where they don't apply (e.g. reference textbooks have no exam_type).

    // For resource_type="notes": which semester the notes are from + what
    // specific topic they cover. `topic` is free-text so a student can write
    // e.g. "Process scheduling + deadlocks" even if the whole course OS is
    // already tagged via `course`.
    semester: {
        type: Number,           // 1..10 (IntMT has up to 10)
        min: 1,
        max: 10,
        default: null
    },
    topic: {
        type: String,
        trim: true,
        default: ""
    },

    // For resource_type="previous_papers": which exam + which year.
    exam_type: {
        type: String,
        enum: ["mid_sem", "end_sem", "quiz", "assignment", ""],
        default: ""
    },
    year: {
        type: Number,           // e.g. 2024
        min: 2000,
        max: 2100,
        default: null
    },
    description: {
        type: String,
        default: ""
    },
    cloudinary_url: {
        type: String,
        required: true
    },
    cloudinary_public_id: {
        type: String,
        required: true
    },
    // Optional cover image URL (autofilled from Google Books on upload).
    // Never user-uploaded — we deliberately don't take files here to keep
    // the PDF form light. When a candidate from Google Books is picked, the
    // thumbnail URL is stored here and rendered on the PDF card / show page.
    // Blank string = no cover; render a generic PDF icon instead.
    cover_url: {
        type: String,
        default: ""
    },
    // Uploaded by which user
    uploadedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User"
    },
    // Set by Python /embed-pdf endpoint
    embedding: {
        type: [Number],
        default: []
    },
    // Set by Python chapter extractor.
    // Each entry: { title: "Chapter 6: Dynamic Programming", page: 287 }
    // page may be null when the PDF has no embedded TOC and we fell back
    // to heuristic scanning (Tier 2). See chapter_extractor.py.
    chapter_headings: {
        type: [{
            title: { type: String },
            page:  { type: Number, default: null }
        }],
        default: []
    },
    download_count: {
        type: Number,
        default: 0
    },
    // Same Review model that physical books use — the schema is
    // generic (body / rating / author) and ref-agnostic, so PDFs can
    // share it. Review IDs are pushed in by POST /pdfs/:id/reviews
    // and pulled out by DELETE. Populated on GET /pdfs/:id so the
    // show page can render the reviews section on the right column,
    // mirroring the physical-book detail page.
    reviews: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: "Review"
    }],
    created_at: {
        type: Date,
        default: Date.now
    }
});

// Text index for keyword fallback search
pdfSchema.index({ title: "text", subject: "text", description: "text" });

module.exports = mongoose.model("Pdf", pdfSchema);
