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
    created_at: {
        type: Date,
        default: Date.now
    }
});

// Text index for keyword fallback search
pdfSchema.index({ title: "text", subject: "text", description: "text" });

module.exports = mongoose.model("Pdf", pdfSchema);
