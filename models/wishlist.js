const mongoose = require("mongoose");
const Schema   = mongoose.Schema;

// ---------------------------------------------------------------------------
// Wishlist Model
//
// A user saves a book they want to read later. Used for two purposes:
//   1. UI — a personal "saved books" page and heart icons across the app
//   2. Recommendation — wishlisted books become a positive signal in the
//      user's taste vector (δ·context_match term of the re-ranking formula)
//      alongside borrow history. See bookswap-ai/app/routes.py
//      get_user_profile tool — wishlist contributions weighted at 4.0 because
//      a wishlist entry is an *explicit declared interest* but not yet a
//      consumed+rated interaction.
//
// One entry = one (user, book) pair. Compound unique index prevents duplicate
// heart-toggles from creating multiple rows.
// ---------------------------------------------------------------------------
const wishlistSchema = new Schema({
    user: {
        type: Schema.Types.ObjectId,
        ref: "User",
        required: true
    },
    book: {
        type: Schema.Types.ObjectId,
        ref: "Books",
        required: true
    },
    created_at: {
        type: Date,
        default: Date.now
    }
});

wishlistSchema.index({ user: 1, book: 1 }, { unique: true });

module.exports = mongoose.model("Wishlist", wishlistSchema);
