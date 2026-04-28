if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}
const mongoose = require("mongoose");
const path = require("path");
const Joi = require("joi");
const BorrowRequest = require("./models/borrowRequest");
const { bookSchema, reviewSchema } = require("./schemas");
const express = require("express");
const { cloudinary } = require("./cloudinary");
const ejsMate = require("ejs-mate");
const catchAsync = require("./utils/catchAsync");
const ExpressError = require("./utils/ExpressError");
const User = require("./models/users");
const Book = require("./models/books");

const Order = require("./models/order");
const Message = require('./models/message');
const flash = require("connect-flash");
const methodOverride = require("method-override");
const session = require("express-session");
const passport = require("passport");
const MongoDBStore = require("connect-mongo");
const mongoSanitize = require("mongo-sanitize");
const LocalStrategy = require("passport-local");
const {
  isLoggedIn,
  validateReview,
  validateBook,
  isAuthor,
  isReviewAuthor,
} = require("./middleware");
const multer = require("multer");
const { storage } = require("./cloudinary/index");
const upload = multer({ storage });
const Review = require("./models/review");
const Pdf = require("./models/pdf");
const Course = require("./models/course");
const Curriculum = require("./models/curriculum");

// Canonical 17 IIT (ISM) Dhanbad departments.
// Hardcoded (rather than Course.distinct('department')) because:
//   (a) the list is fixed for the institute, refreshed only on NEP updates
//   (b) saves a DB roundtrip on every upload page render
//   (c) guarantees a stable display order regardless of DB seed order
// Source: bookswap-ai/scripts/fetch_iitism_courses.py
const IITISM_DEPARTMENTS = [
  { code: "AGL",  name: "Applied Geology" },
  { code: "AGP",  name: "Applied Geophysics" },
  { code: "CHE",  name: "Chemical Engineering" },
  { code: "CCB",  name: "Chemistry and Chemical Biology" },
  { code: "CVE",  name: "Civil Engineering" },
  { code: "CSE",  name: "Computer Science and Engineering" },
  { code: "EE",   name: "Electrical Engineering" },
  { code: "ECE",  name: "Electronics Engineering" },
  { code: "ESE",  name: "Environmental Science & Engineering" },
  { code: "FMME", name: "Fuel Mineral & Metallurgical Engineering" },
  { code: "HSS",  name: "Humanities and Social Sciences" },
  { code: "MSIE", name: "Management Studies and Industrial Engineering" },
  { code: "MC",   name: "Mathematics and Computing" },
  { code: "MECH", name: "Mechanical Engineering" },
  { code: "ME",   name: "Mining Engineering" },
  { code: "PE",   name: "Petroleum Engineering" },
  { code: "PHY",  name: "Physics" }
];
const Wishlist = require("./models/wishlist");
const axios = require("axios");
const FormData = require("form-data");

// PDF-specific Cloudinary storage (raw resource type to allow PDFs)
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const pdfStorage = new CloudinaryStorage({
  cloudinary: require("./cloudinary").cloudinary,
  params: {
    folder: "bookswap_pdfs",
    resource_type: "raw",
    allowedFormats: ["pdf"],
  },
});
// `uploadPdf` is the legacy direct-to-Cloudinary multer instance, used by
// /curriculum (lecture plans are tiny — Cloudinary 10 MB cap is never
// hit). Book PDFs go through `uploadPdfMemory` below so we can run them
// through Python compression before Cloudinary sees them.
const uploadPdf = multer({ storage: pdfStorage });

// In-memory multer for the book-upload pipeline. We need the raw bytes
// in Node so we can (a) measure size, (b) optionally bounce to Python
// for lossless compression, (c) push to Cloudinary via SDK. Cloudinary's
// free plan rejects >10 MB raw uploads; without this interception the
// user gets a Cloudinary error instead of a smooth save.
//
// 50 MB ceiling on the *upload* (before compression). Real textbooks
// rarely exceed this; if they do, the user gets multer's clean
// "file too large" error instead of a more confusing downstream failure.
const uploadPdfMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// Helper: ensure a PDF buffer fits Cloudinary's 10 MB raw-upload cap.
// Calls the Python /compress-pdf endpoint when the buffer is over the
// soft limit (9.5 MB — leaves headroom for Cloudinary's own metadata
// overhead). Returns the (possibly smaller) buffer. Throws an Error
// with a user-friendly message when even lossless compression is
// insufficient — the caller should surface that message via flash().
async function ensurePdfFitsCloudinary(buffer, originalName) {
  const SOFT_LIMIT = 9.5 * 1024 * 1024;
  if (buffer.length <= SOFT_LIMIT) return buffer;

  const aiUrl = process.env.AI_SERVICE_URL || "http://127.0.0.1:8001";
  const formData = new FormData();
  formData.append("file", buffer, {
    filename: originalName || "book.pdf",
    contentType: "application/pdf",
  });

  try {
    const resp = await axios.post(`${aiUrl}/compress-pdf`, formData, {
      headers: formData.getHeaders(),
      timeout: 60000,            // textbook compression can take 20-30 s
      responseType: "arraybuffer",
      // We want a non-2xx (e.g. 413 "still too big") to throw so the
      // catch block can extract the JSON error payload and surface it
      // to the user. axios's default behaviour suits us here.
    });
    return Buffer.from(resp.data);
  } catch (err) {
    // 413 from Python = lossless wasn't enough. The response body has
    // a JSON payload we can show the user verbatim.
    if (err.response && err.response.status === 413) {
      let payload;
      try {
        payload = JSON.parse(Buffer.from(err.response.data).toString("utf8"));
      } catch {
        payload = {};
      }
      const msg = payload.suggestion ||
        "PDF is too large even after compression. Please use a desktop tool to reduce file size.";
      const e = new Error(msg);
      e.userFacing = true;
      throw e;
    }
    // Anything else — Python down, network timeout, etc. — log and let
    // the original buffer through. Cloudinary will then reject if the
    // file is over 10 MB, but at least we're not blocking on a flaky
    // service for the common <10 MB case.
    console.warn("PDF compression service failed, falling through:", err.message);
    return buffer;
  }
}

// Helper: upload a PDF buffer to Cloudinary via the SDK. Mirrors the
// shape `multer-storage-cloudinary` would have produced (`path` and
// `filename`) so existing code paths that read those fields continue
// to work without modification.
function uploadBufferToCloudinary(buffer, folder, originalname) {
  const { cloudinary } = require("./cloudinary");
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: "raw",
        // public_id can't have spaces or non-ASCII; sanitise the
        // original filename and prefix with timestamp for uniqueness.
        public_id: `${Date.now()}_${(originalname || "pdf")
          .replace(/\.pdf$/i, "")
          .replace(/[^a-zA-Z0-9_-]/g, "_")
          .slice(0, 100)}`,
      },
      (err, result) => (err ? reject(err) : resolve(result)),
    );
    stream.end(buffer);
  });
}

const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const dbUrl = process.env.DB_URL || "mongodb://localhost:27017/books";
// process.env.DB_URL ||
mongoose.connect(dbUrl, {
  useNewUrlParser: true,
  // useCreateIndex: true,
  useUnifiedTopology: true,
  // useFindAndModify: false
});

const db = mongoose.connection;
db.on("error", console.error.bind(console, "connection error:"));
db.once("open", () => {
  console.log("Database connected", dbUrl);
});

const app = express();

app.engine("ejs", ejsMate);
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: true }));
app.use(methodOverride("_method"));
app.use(express.static(path.join(__dirname, "public")));
const FileStore = require("session-file-store")(session); //because req.user was undefined i installed session-file-store and added the store part in sessionConfig
// app.use(mongoSanitize({
//   replaceWith:'_'
// }))

const secret = process.env.SECRET || "thisshouldbeabettersecret!";

const store = MongoDBStore.create({
  mongoUrl: dbUrl,
  secret,
  touchAfter: 24 * 3600, //time in seconds
});
// const store=MongoDBStore.create({
//   mongoUrl:dbUrl,
// })

store.on("error", function (e) {
  console.log("session Store Error", e);
});

const sessionConfig = {
  store,
  secret,
  resave: false,
  saveUninitialized: true,
  cookie: {
    httpOnly: true,
    expires: Date.now() + 1000 * 60 * 60 * 24 * 7,
    maxAge: 1000 * 60 * 60 * 24 * 7,
  },
};

app.use(session(sessionConfig));
app.use(flash());

app.use(passport.initialize());
app.use(passport.session());
passport.use(new LocalStrategy(User.authenticate()));

passport.serializeUser(User.serializeUser());
passport.deserializeUser(User.deserializeUser());

app.use((req, res, next) => {
  console.log(req.session);
  res.locals.currentUser = req.user;
  res.locals.success = req.flash("success");
  res.locals.error = req.flash("error");
  next();
});

// Populate wishlist count on every request so the navbar badge renders
// without every route having to fetch it. Non-fatal: if the lookup fails
// (e.g. transient Atlas hiccup), we fall back to 0 rather than 500ing.
app.use(async (req, res, next) => {
  res.locals.wishlistCount = 0;
  if (req.user) {
    try {
      res.locals.wishlistCount = await Wishlist.countDocuments({ user: req.user._id });
    } catch (e) {
      // swallow — badge just shows 0
    }
  }
  next();
});

app.get("/books", catchAsync(async (req, res) => {
    const { query, genre, author, department, course, year, min_rating, available, sort } = req.query;
    let searchResults = [];
    let personalRecommendations = [];

    if (query && query.trim() !== "") {
        const response = await fetch(`${process.env.AI_SERVICE_URL}/search`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query, top_k: 5 })
        });
        const data = await response.json();
        searchResults = data.results;
    }

    if (req.user) {
        try {
            const user = await User.findById(req.user._id);
            if (user.borrowedBooks && user.borrowedBooks.length > 0) {
                const populatedUser = await User.findById(req.user._id).populate('borrowedBooks');
                const Review = require('./models/review');

                const booksWithRatings = await Promise.all(
                    populatedUser.borrowedBooks.map(async (book) => {
                        const review = await Review.findOne({
                            author: req.user._id,
                            _id: { $in: book.reviews }
                        });
                        return {
                            book_id: book._id.toString(),
                            rating: review ? review.rating : 1
                        };
                    })
                );
                const response = await fetch(`${process.env.AI_SERVICE_URL}/recommend-personal`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    // Over-fetch so that after dropping this user's own
                    // listings we still have ~5 recs to show.
                    body: JSON.stringify({ books: booksWithRatings, top_k: 15 })
                });
                const data = await response.json();
                const recs = data.results || [];

                // Filter out books the current user owns — recommending
                // someone their own listing is obviously wrong.
                const recIds = recs.map(b => b._id).filter(Boolean);
                const ownedSet = new Set(
                    (await Book.find({ _id: { $in: recIds }, owner: req.user._id })
                        .select('_id'))
                        .map(b => b._id.toString())
                );
                personalRecommendations = recs
                    .filter(b => !ownedSet.has(String(b._id)))
                    .slice(0, 5);
            }
        } catch (err) {
            console.log("Personal recommendations failed:", err);
        }
    }

    // -----------------------------------------------------------------
    // Build MongoDB filter from query-string params.
    // Each filter is only applied when the corresponding param is set,
    // so an unfiltered /books still returns everything.
    // -----------------------------------------------------------------
    const filter = {};
    if (genre)      filter.genre      = genre;
    if (author)     filter.author     = new RegExp(author, 'i');        // case-insensitive substring
    if (department) filter.department = new RegExp(department, 'i');
    if (course)     filter.course     = new RegExp(course, 'i');
    if (year)       filter.publication_year = Number(year);
    if (min_rating) filter.avg_rating = { $gte: Number(min_rating) };   // denormalised avg
    if (available === 'true') filter.available = true;

    // -----------------------------------------------------------------
    // CLUSTERING: group listings by normalised (title+author) so the same
    // book listed by multiple owners shows up as ONE card. The card shows
    // aggregate info ("3 of 5 copies available"), and clicking it leads
    // to the cluster detail (books/show) where the user picks which
    // specific owner's copy to borrow.
    //
    // Why normalise in Mongo (not Node): normalisation + grouping in a
    // single aggregation is one DB round-trip; doing it in Node would
    // require loading every listing matching `filter` and grouping
    // client-side — fine now, painful at scale.
    //
    // We keep the post-cluster sort in the pipeline so it matches the
    // user's chosen sort key (newest / rating / title).
    // -----------------------------------------------------------------
    let sortStage = { latest_id: -1 };                          // newest cluster first
    if (sort === 'rating') sortStage = { avg_rating: -1, latest_id: -1 };
    if (sort === 'title')  sortStage = { title: 1 };

    const pipeline = [
        { $match: filter },
        { $addFields: {
            // Normalise for grouping: lowercase, trim. Titles like
            // "Clean Code " and "clean code" will cluster together.
            _titleKey:  { $toLower: { $trim: { input: { $ifNull: ["$title",  ""] } } } },
            _authorKey: { $toLower: { $trim: { input: { $ifNull: ["$author", ""] } } } }
        }},
        { $group: {
            _id: { title: "$_titleKey", author: "$_authorKey" },
            representative_id: { $first: "$_id" },              // card links here
            title:      { $first: "$title" },
            author:     { $first: "$author" },
            genre:      { $first: "$genre" },
            department: { $first: "$department" },
            course:     { $first: "$course" },
            description:{ $first: "$description" },
            cover:      { $first: { $ifNull: [{ $arrayElemAt: ["$images.url", 0] }, null] } },
            avg_rating: { $max: "$avg_rating" },                // best among copies
            copies_total:     { $sum: 1 },
            copies_available: { $sum: { $cond: [{ $eq: ["$available", true] }, 1, 0] } },
            listing_ids: { $push: "$_id" },                     // for wishlist check
            latest_id:   { $max: "$_id" }                       // sort key
        }},
        { $sort: sortStage }
    ];
    const clusters = await Book.aggregate(pipeline);

    // Populate datalist suggestions for the filter bar
    const distinctCourses     = (await Book.distinct('course')).filter(Boolean);
    const distinctDepartments = (await Book.distinct('department')).filter(Boolean);

    // Load the set of book (listing) IDs this user has wishlisted. A
    // cluster counts as "saved" if ANY of its listings is wishlisted —
    // the template does that check. Kept as a Set<string> for O(1) lookup.
    let wishlistedIds = new Set();
    if (req.user) {
        const saved = await Wishlist.find({ user: req.user._id }).select('book');
        wishlistedIds = new Set(saved.map(w => w.book.toString()));
    }

    res.render("books/index", {
        clusters, searchResults, query: query || "", personalRecommendations,
        filters: { genre, author, department, course, year, min_rating, available, sort },
        // distinct* are kept for any code paths still using the old
        // datalist autocomplete; the new cascading dropdown sources its
        // department list from filterDepartments (canonical IIT ISM list)
        // and its course list from /api/courses?dept=<code> at runtime.
        distinctCourses, distinctDepartments,
        filterDepartments: IITISM_DEPARTMENTS,
        wishlistedIds
    });
}));

app.get("/register", (req, res) => {
  res.render("users/register");
});

app.post("/register", async (req, res, next) => {
  try {
    const { email, username, password } = req.body;
    const user = new User({ email, username });
    const registeredUser = await User.register(user, password);
    console.log(registeredUser);

    // res.redirect("/books");
    req.login(registeredUser, (err) => {
      //logs in user after registering
      if (err) return next(err);
      req.flash("success", "Welcome !");
      res.redirect("/books");
    });
  } catch (e) {
    req.flash("error", e.message);
    console.log(e);
    res.redirect("register");
  }
});

app.get("/login", (req, res) => {
  res.render("users/login");
});

app.post(
  "/login",
  passport.authenticate("local", {
    failureFlash: true,
    failureRedirect: "/login",
    keepSessionInfo: true,
  }),
  (req, res) => {
    //if we make it to here it means someone was logged in successfully  and the stuff below will run after that

    console.log("logged in");
    //    const user =req.body;
    //     res.render('users/profile',{user});

    const redirectUrl = req.session.returnTo || "/books";
    console.log(req.session.returnTo);
    console.log(redirectUrl);
    delete req.session.returnTo;
    req.flash("success", "welcome back!");
    res.redirect(redirectUrl);
  }
);

app.use(function (req, res, next) {
  app.locals.user = req.user;
  next();
});

app.get(
  "/profile",
  isLoggedIn,
  catchAsync(async (req, res, next) => {
    const user = req.user;
    const books = await Book.find({ owner: user._id });

    // Helper: drop borrow records whose populated `book` or counter-party
    // user is null. Mongoose's populate returns null for ObjectIds whose
    // target document was deleted (rather than throwing), so dangling
    // references would otherwise crash the EJS or render misleadingly.
    // This is the source of the "(book no longer available)" rows the
    // tester saw — those records came from books the lender deleted
    // after the borrow was approved.
    const dropDangling = (req, sides) => req.filter(r => sides.every(side => r[side]));

    const borrowRequests = dropDangling(
      await BorrowRequest.find({ owner: user._id, status: 'pending' })
        .populate('book').populate('borrower'),
      ['book', 'borrower']
    );
    const myBorrowRequests = dropDangling(
      await BorrowRequest.find({ borrower: user._id })
        .populate('book').populate('owner'),
      ['book', 'owner']
    );

    // "Books You Are Borrowing" is now derived directly from approved
    // BorrowRequest documents rather than from the denormalised
    // user.borrowedBooks ObjectId array. Reason: the array can drift
    // out of sync with reality (a book gets deleted; the array still
    // holds its id; Book.find returns nothing for that id; the section
    // appears empty even though the user clearly has approved borrows
    // showing in My Borrow Requests). Deriving from BorrowRequest with
    // populate keeps the two sections consistent.
    const approvedAsBorrower = dropDangling(
      await BorrowRequest.find({ borrower: user._id, status: 'approved' })
        .populate('book'),
      ['book']
    );
    const borrowedBooks = approvedAsBorrower.map(r => r.book);

    const lentBooks = await Book.find({
      owner: user._id,
      available: false
    });
    const activeLentRequests = dropDangling(
      await BorrowRequest.find({ owner: user._id, status: 'approved' })
        .populate('book').populate('borrower'),
      ['book', 'borrower']
    );
    res.render("users/profile", { user, books, borrowRequests, myBorrowRequests, borrowedBooks, lentBooks, activeLentRequests });
  })
);

app.get("/logout", isLoggedIn, function (req, res, next) {
  req.logout(function (err) {
    if (err) {
      return next(err);
    }
    req.flash("success", "Logged out successfully");
    res.redirect("/");
  });
});

app.get("/books/new", isLoggedIn, (req, res) => {
  // Course/department values now come from the canonical IIT ISM catalogue:
  // departments hardcoded server-side (17 entries, no DB roundtrip needed),
  // courses fetched client-side from /api/courses?dept=<code> when the user
  // picks a department.
  res.render("books/new", { departments: IITISM_DEPARTMENTS });
});

app.get(
  "/books/:id",
  catchAsync(async (req, res) => {
    const book = await Book.findById(req.params.id)
      .populate("owner")
      .populate({
        path: "reviews",
        populate: {
          path: "author",
        },
      });

    let similarBooks = [];
    try {
      const response = await fetch(`${process.env.AI_SERVICE_URL}/similar-books`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Over-fetch: we'll drop the viewer's own listings + any other
        // copies of THIS same book (those already show in "Other copies").
        body: JSON.stringify({ book_id: book._id, top_k: 15 })
      });
      const data = await response.json();
      const rawSimilar = data.results || [];

      // Exclude: (1) the viewer's own listings, (2) other copies of the
      // SAME book (duplicate of the "Other copies" section above).
      const simIds = rawSimilar.map(b => b._id).filter(Boolean);
      const simDocs = await Book.find({ _id: { $in: simIds } })
          .select('_id title author owner');
      const titleKeyShown  = (book.title  || '').trim().toLowerCase();
      const authorKeyShown = (book.author || '').trim().toLowerCase();
      const viewerId = req.user ? req.user._id.toString() : null;
      const dropSet = new Set(
          simDocs.filter(d => {
              const tk = (d.title  || '').trim().toLowerCase();
              const ak = (d.author || '').trim().toLowerCase();
              const isOwnListing   = viewerId && d.owner && d.owner.toString() === viewerId;
              const isSameBookCopy = tk === titleKeyShown && ak === authorKeyShown;
              return isOwnListing || isSameBookCopy;
          }).map(d => d._id.toString())
      );
      similarBooks = rawSimilar
          .filter(b => !dropSet.has(String(b._id)))
          .slice(0, 5);
    } catch (err) {
      console.log("Similar books failed:", err);
    }

    const activeBorrowRequest = await BorrowRequest.findOne({ 
      book: req.params.id, 
      status: 'approved' 
    }).populate('borrower');

    const currentUserId = req.user ? req.user._id : null;

    const userBorrowRequest = currentUserId ? await BorrowRequest.findOne({
      book: req.params.id,
      borrower: currentUserId,
      status: { $in: ['pending', 'approved'] }
    }) : null;

    const ownerId = book.owner._id;

    // Is this book wishlisted by the current user? Controls the initial
    // state of the heart button on the show page.
    let isWishlisted = false;
    if (currentUserId) {
        const w = await Wishlist.findOne({ user: currentUserId, book: book._id });
        isWishlisted = !!w;
    }

    // ---------------------------------------------------------------
    // CLUSTER SIBLINGS — "Other copies available"
    // Find every OTHER listing with the same normalised (title, author).
    // The show page becomes the cluster detail view: user sees this copy
    // in full + a list of other owners they could borrow from instead.
    // Sort by availability-first so borrowable copies float to the top.
    // ---------------------------------------------------------------
    const titleKey  = (book.title  || '').trim().toLowerCase();
    const authorKey = (book.author || '').trim().toLowerCase();
    const otherCopies = await Book.aggregate([
        { $match: { _id: { $ne: book._id } } },
        { $addFields: {
            _titleKey:  { $toLower: { $trim: { input: { $ifNull: ["$title",  ""] } } } },
            _authorKey: { $toLower: { $trim: { input: { $ifNull: ["$author", ""] } } } }
        }},
        { $match: { _titleKey: titleKey, _authorKey: authorKey } },
        { $lookup: {
            from: "users",
            localField: "owner",
            foreignField: "_id",
            as: "owner_doc"
        }},
        { $addFields: { owner_doc: { $arrayElemAt: ["$owner_doc", 0] } } },
        { $project: {
            _id: 1, title: 1, author: 1, available: 1, avg_rating: 1,
            images: 1, price: 1,
            "owner_doc._id": 1, "owner_doc.username": 1
        }},
        { $sort: { available: -1, _id: -1 } }                  // available first
    ]);

    res.render("books/show", {
        book, currentUserId, ownerId, similarBooks,
        activeBorrowRequest, userBorrowRequest, isWishlisted,
        otherCopies
    });
  })
);

app.post(
  "/books",
  isLoggedIn,
  validateBook,
  upload.array("image"),
  catchAsync(async (req, res) => {
    if (!req.body.book) throw new ExpressError("Invalid Book Data", 400);
    // cover_url is autofilled from Google Books on the upload form — it's
    // not a Book schema field, so pull it out before constructing the doc.
    // If the user didn't upload any image files, we fall back to the
    // Google Books cover as the book's (only) image. This keeps storage
    // cost at zero for users who don't want to upload their own photos.
    const coverUrl = req.body.book.cover_url;
    delete req.body.book.cover_url;
    const book = new Book(req.body.book);
    book.images = req.files.map((f) => ({ url: f.path, filename: f.filename }));
    if (coverUrl && book.images.length === 0) {
        book.images.push({ url: coverUrl, filename: "" });
    }
    book.owner = req.user._id;
    // console.log(req.user);
    await book.save();
    // async embedding - fire and forget
    fetch(`${process.env.AI_SERVICE_URL}/embed-book`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ book_id: book._id.toString() })
    }).catch(err => console.log("Embedding failed:", err));
    // console.log(book);
    // console.log("book saved");
    req.flash("success", "Book posted!");
    res.redirect(`books/${book._id}`);
  })
);

app.get(
  "/books/:id/edit",
  isLoggedIn,
  isAuthor,
  catchAsync(async (req, res) => {
    // console.log(req.params.id);

    // console.log(id)
    const book = await Book.findById(req.params.id);
    const { id } = req.params.id;
    if (!book) {
      req.flash("error", "Cannot find that book!");
      return res.redirect("/books");
    }

    res.render("books/edit", { book });
  })
);

app.post(
  "/books/:id/borrow",
  isLoggedIn,
  catchAsync(async (req, res) => {
    const book = await Book.findById(req.params.id);
    const borrowRequest = new BorrowRequest({
      book: book._id,
      borrower: req.user._id,
      owner: book.owner,
      returnDate: req.body.returnDate
    });
    await borrowRequest.save();
    req.flash("success", "Borrow request submitted!");
    res.redirect(`/books/${book._id}`);
  })
);

app.put(
  "/books/:id",
  isLoggedIn,
  isAuthor,
  validateBook,
  upload.array("image"),

  catchAsync(async (req, res) => {
    // console.log(req.body)
    const { id } = req.params;
    const book = await Book.findByIdAndUpdate(id, { ...req.body.book });
    const imgs = req.files.map((f) => ({ url: f.path, filename: f.filename })); //this is an array and we cant push an entire array in an already existing array bcz of our mongoschema definition hence we break it and push the contents
    book.images.push(...imgs);
    if (req.body.deleteImages) {
      for (let filename of req.body.deleteImages) {
        await cloudinary.uploader.destroy(filename);
      }
      await book.updateOne({
        $pull: { images: { filename: { $in: req.body.deleteImages } } },
      });
      // console.log(book)
    }
    await book.save();
    req.flash("success", "Successfully updated book!");
    res.redirect(`${book._id}`);
  })
);

app.delete(
  "/books/:id",
  isLoggedIn,
  isAuthor,
  catchAsync(async (req, res) => {
    const { id } = req.params;
    const book = await Book.findByIdAndDelete(id);
    req.flash("success", "Successfully deleted book!");
    res.redirect("/books");
  })
);

app.get(
  "/books/:id/payment",
  isLoggedIn,
  catchAsync(async (req, res) => {
    // console.log(req.params.id);
    const book = await Book.findById(req.params.id);
    const user = req.user;
    // console.log(req.user);
    res.render("users/payment", { book, user });
  })
);

app.get(
  "/books/:id/order",
  isLoggedIn,
  catchAsync(async (req, res) => {
    // console.log(req.params.id);
    const book = await Book.findById(req.params.id);
    const user = req.user;
    console.log(req.user);
    res.render("users/order", { book, user });
  })
);

app.post(
  "/books/:id/order",
  isLoggedIn,
  catchAsync(async (req, res) => {
    console.log("REQUEDTGFDGFHHDHGRDGR", req.body);
    const book = await Book.findById(req.params.id);
    const order = new Order(req.body);
    await order.save();
    // console.log("order placed..........");
    res.redirect(`/books/${book._id}/payment`);
  })
);

// Helper — recompute avg_rating from all reviews on a book.
// Called after any review is posted or deleted so the denormalised
// avg_rating on the Book document stays in sync.
// Why denormalise: rating filter on /books needs O(1) MongoDB query,
// not an aggregation join across thousands of reviews per request.
async function recomputeAvgRating(bookId) {
  const book = await Book.findById(bookId).populate('reviews');
  if (!book) return;
  const reviews = book.reviews || [];
  if (reviews.length === 0) {
    book.avg_rating = 0;
  } else {
    const sum = reviews.reduce((acc, r) => acc + (r.rating || 0), 0);
    book.avg_rating = sum / reviews.length;
  }
  await book.save();
}

app.post(
  "/books/:id/reviews",
  isLoggedIn,
  validateReview,
  catchAsync(async (req, res) => {
    const book = await Book.findById(req.params.id);

    // Defense-in-depth: the view hides the review form for owners, but a
    // hand-crafted POST could still hit this route. Block it here too.
    if (book.owner && book.owner.toString() === req.user._id.toString()) {
      req.flash("error", "You can't review your own book.");
      return res.redirect(`/books/${book._id}`);
    }

    const review = new Review(req.body.review);
    review.author = req.user._id;
    book.reviews.push(review);
    await review.save();
    await book.save();
    await recomputeAvgRating(book._id);   // keep denormalised avg in sync
    req.flash("success", "Created new review!");
    res.redirect(`/books/${book._id}`);
  })
);

app.delete(
  "/books/:id/reviews/:reviewId",
  isLoggedIn,
  isReviewAuthor,
  catchAsync(async (req, res) => {
    const { id, reviewId } = req.params;
    await Book.findByIdAndUpdate(id, { $pull: { reviews: reviewId } });
    await Review.findByIdAndDelete(reviewId);
    await recomputeAvgRating(id);         // keep denormalised avg in sync
    req.flash("success", "Review deleted!");
    res.redirect(`/books/${id}`);
  })
);

// ---------------------------------------------------------------------------
// WISHLIST
// ---------------------------------------------------------------------------
// POST /wishlist/:bookId/toggle — idempotent add/remove.
//   Returns JSON so the heart button can update without a full page reload.
//   Falls back gracefully to a redirect for no-JS clients.
//
// GET  /wishlist — list of books the current user has saved.
//
// Design note: we intentionally use a single toggle endpoint instead of
// separate add/remove routes. The client doesn't need to know current state
// — the server resolves it with a findOne + (create || delete) in one call.
// ---------------------------------------------------------------------------
app.post("/wishlist/:bookId/toggle", isLoggedIn, catchAsync(async (req, res) => {
    const { bookId } = req.params;
    const userId = req.user._id;

    const existing = await Wishlist.findOne({ user: userId, book: bookId });
    let saved;
    if (existing) {
        await Wishlist.deleteOne({ _id: existing._id });
        saved = false;
    } else {
        try {
            await Wishlist.create({ user: userId, book: bookId });
            saved = true;
        } catch (err) {
            // Race-condition safety: if a parallel request created the entry
            // between our findOne and create, treat it as "now saved".
            if (err.code === 11000) saved = true;
            else throw err;
        }
    }

    // Wants JSON (fetch-driven heart button)?
    if (req.xhr || (req.headers.accept || "").includes("application/json")) {
        return res.json({ saved });
    }
    // Fallback: plain POST, send them back where they came from.
    return res.redirect(req.get("Referer") || "/books");
}));

app.get("/wishlist", isLoggedIn, catchAsync(async (req, res) => {
    // Populate the full book doc so the view can show cover + availability.
    // Sort newest-first so recent saves are at the top.
    const entries = await Wishlist.find({ user: req.user._id })
        .populate("book")
        .sort({ created_at: -1 });

    // Filter out entries whose book has been deleted (populate returns null).
    const books = entries.map(e => e.book).filter(Boolean);

    res.render("wishlist/index", { books });
}));

// ---------------------------------------------------------------------------
// GOOGLE BOOKS METADATA PROXY — autofill for the upload form
// ---------------------------------------------------------------------------
// GET /api/book-metadata?title=...&author=...
//   Queries Google Books' public search API (no API key needed for basic use)
//   and returns a normalised payload the new-book form can paste into its
//   fields. We proxy server-side so:
//     (a) cross-origin + rate-limit concerns stay on the backend
//     (b) the API URL / key (if later needed) is never in browser code
//     (c) we can trim the 5KB Google response down to the 6 fields we use
// ---------------------------------------------------------------------------
app.get("/api/book-metadata", catchAsync(async (req, res) => {
    const { title, author } = req.query;
    if (!title || !title.trim()) {
        return res.status(400).json({ error: "title query parameter required" });
    }

    // Build Google Books query. `intitle:` scopes the match to titles; if an
    // author is also given we AND it with `inauthor:` for sharper results.
    let q = `intitle:${title.trim()}`;
    if (author && author.trim()) q += `+inauthor:${author.trim()}`;

    // Append the API key when one is configured. Without a key, Google
    // Books rate-limits unauthenticated requests at ~1,000/day per IP —
    // and since Render's outbound IPs are shared with other tenants who
    // also hit Google Books, the limit is effectively much lower in
    // practice and 429s start hitting after a handful of upload attempts.
    // With a key the quota jumps to 100,000+ requests/day per project,
    // scoped to our own account. The key is free (no card required) and
    // is set as GOOGLE_BOOKS_API_KEY in Render's env vars.
    let url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=5`;
    const apiKey = process.env.GOOGLE_BOOKS_API_KEY;
    if (apiKey) {
        url += `&key=${encodeURIComponent(apiKey)}`;
    }

    try {
        // Bumped from 6 s to 15 s — on Render free plan, cold first-call
        // out to googleapis.com routes through Cloudflare and routinely
        // takes 7-10 s before the connection settles. The 6 s ceiling
        // produced spurious 502s on the new-book form's auto-fill.
        const resp = await axios.get(url, { timeout: 15000 });
        const items = resp.data.items || [];
        if (items.length === 0) {
            return res.json({ found: false });
        }

        // Return the top 5 candidates so the UI can let the user pick the
        // right edition (e.g. when multiple editions of the same book exist).
        const candidates = items.slice(0, 5).map(item => {
            const v = item.volumeInfo || {};
            const isbn = (v.industryIdentifiers || []).find(i => i.type === "ISBN_13")
                      || (v.industryIdentifiers || []).find(i => i.type === "ISBN_10");
            // Google returns http:// image URLs by default — force https to
            // avoid mixed-content blocks on our https site.
            let cover = (v.imageLinks && (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail)) || null;
            if (cover) cover = cover.replace(/^http:/, "https:");
            return {
                title:            v.title || "",
                authors:          v.authors || [],
                description:      v.description || "",
                published_date:   v.publishedDate || "",           // e.g. "2017-05-16"
                publication_year: v.publishedDate ? parseInt(v.publishedDate.substring(0, 4), 10) : null,
                page_count:       v.pageCount || null,
                categories:       v.categories || [],              // Google's genre hints
                cover_url:        cover,
                isbn:             isbn ? isbn.identifier : null
            };
        });

        return res.json({ found: true, candidates });
    } catch (err) {
        // Surface rate-limit (429/403) distinctly so the frontend can
        // show a helpful "API key not configured" message instead of a
        // generic "service unavailable" — saves the next debugger from
        // chasing a non-issue.
        const upstreamStatus = err.response && err.response.status;
        if (upstreamStatus === 429 || upstreamStatus === 403) {
            console.warn("Google Books rate-limited:", upstreamStatus, "- set GOOGLE_BOOKS_API_KEY env var");
            return res.status(503).json({
                error: "Google Books rate limit reached. Set GOOGLE_BOOKS_API_KEY to authenticate requests."
            });
        }
        console.log("Google Books proxy failed:", err.message);
        return res.status(502).json({ error: "metadata service unavailable" });
    }
}));

// ---------------------------------------------------------------------------
// GET /api/courses?dept=<department_code>
//
// Returns the canonical course list for one department, feeding the cascading
// course dropdown on PDF/book upload forms.
//
// Contract:
//   - `dept` is REQUIRED (400 otherwise). With 1,570 courses in the catalogue,
//     a single flat dropdown is unusable; the UI must pick a department first.
//   - Returns [{ code, name, type }] sorted by code.
//       type ∈ { "Theory", "Practical", "Modular", "Audit", "Thesis", "Project" }
//       The catalogue prints course_type for ~96% of rows; the 68 theses /
//       projects come through with a blank course_type and an LTP like
//       "0-0-0 (36)" — we infer the label from the course name so the user
//       sees something meaningful in the dropdown.
//   - No auth — this is public reference data, low risk.
// ---------------------------------------------------------------------------
app.get("/api/courses", catchAsync(async (req, res) => {
    const dept = (req.query.dept || "").trim().toUpperCase();
    if (!dept) {
        return res.status(400).json({
            error: "dept query parameter required (e.g. /api/courses?dept=MC)"
        });
    }

    const docs = await Course.find({ department_code: dept })
                             .sort({ code: 1 })
                             .lean();

    const courses = docs.map(c => {
        let type = (c.course_type || "").trim();
        if (!type) {
            // Blank course_type — catalogue printed an untyped row. Infer a
            // readable label from the name (catches ~68 thesis/project rows
            // with non-standard LTP strings like "0-0-0 (36)").
            const nameLc = (c.name || "").toLowerCase();
            if (nameLc.includes("thesis")) type = "Thesis";
            else if (nameLc.includes("project")) type = "Project";
            else if (nameLc.includes("seminar")) type = "Seminar";
            else type = "—";
        }
        return { code: c.code, name: c.name, type };
    });

    res.json({
        department_code: dept,
        count: courses.length,
        courses
    });
}));

app.post('/chat/:userId/delete', async (req, res) => {
  const currentUserId = req.user._id;
  const chatPartnerId = req.params.userId;

  await Message.deleteMany({
    $or: [
      { sender: currentUserId, receiver: chatPartnerId },
      { sender: chatPartnerId, receiver: currentUserId }
    ]
  });

  res.redirect('/chat');
});

app.post('/borrow/:requestId/accept', isLoggedIn, catchAsync(async (req, res) => {
  const { requestId } = req.params;
  const borrowRequest = await BorrowRequest.findById(requestId).populate('book').populate('borrower');
  
  if (!borrowRequest) {
    req.flash('error', 'Borrow request not found');
    return res.redirect('/profile');
  }
  
  if (borrowRequest.owner.toString() !== req.user._id.toString()) {
    req.flash('error', 'You are not authorized to approve this request');
    return res.redirect('/profile');
  }
  
  borrowRequest.status = 'approved';
  await borrowRequest.save();
  
  await User.findByIdAndUpdate(borrowRequest.borrower, {
    $push: { borrowedBooks: borrowRequest.book._id }
  });
  
  await Book.findByIdAndUpdate(borrowRequest.book._id, {
    $set: { available: false }
  });

  // If the borrower had wishlisted this copy, drop it — you don't "wish" for
  // a book you now have. Keeps the wishlist meaningful (only stuff you
  // actually want and don't yet have).
  try {
    await Wishlist.deleteOne({ user: borrowRequest.borrower._id, book: borrowRequest.book._id });
  } catch (e) { /* non-fatal */ }

  const suggestion = `Hi ${borrowRequest.borrower.username}! Your borrow request for "${borrowRequest.book.title}" has been accepted. Let's decide where to meet to exchange the book!`;
  res.redirect(`/chat/${borrowRequest.borrower._id}?suggestion=${encodeURIComponent(suggestion)}`);
}));

app.post('/borrow/:requestId/reject', isLoggedIn, catchAsync(async (req, res) => {
  const { requestId } = req.params;
  const borrowRequest = await BorrowRequest.findById(requestId);
  
  if (!borrowRequest) {
    req.flash('error', 'Borrow request not found');
    return res.redirect('/profile');
  }
  
  if (borrowRequest.owner.toString() !== req.user._id.toString()) {
    req.flash('error', 'You are not authorized to reject this request');
    return res.redirect('/profile');
  }
  
  borrowRequest.status = 'rejected';
  await borrowRequest.save();
  
  req.flash('success', 'Borrow request rejected.');
  res.redirect('/profile');
}));

app.post('/borrow/:requestId/return', isLoggedIn, catchAsync(async (req, res) => {
  const { requestId } = req.params;
  const borrowRequest = await BorrowRequest.findById(requestId).populate('book');

  if (!borrowRequest) {
    req.flash('error', 'Borrow request not found');
    return res.redirect('/profile');
  }

  if (borrowRequest.owner.toString() !== req.user._id.toString()) {
    req.flash('error', 'Only the book owner can mark a book as returned');
    return res.redirect('/profile');
  }

  if (borrowRequest.status !== 'approved') {
    req.flash('error', 'This book is not currently borrowed');
    return res.redirect('/profile');
  }

  borrowRequest.status = 'returned';
  await borrowRequest.save();

  await Book.findByIdAndUpdate(borrowRequest.book._id, {
    $set: { available: true }
  });

  await User.findByIdAndUpdate(borrowRequest.borrower, {
    $pull: { borrowedBooks: borrowRequest.book._id }
  });

  req.flash('success', 'Book marked as returned!');
  res.redirect('/profile');
}));

app.post('/chat/:userId/block', async (req, res) => {
  const currentUserId = req.user._id;
  const chatPartnerId = req.params.userId;

  await User.findByIdAndUpdate(currentUserId, {
    $addToSet: { blockedUsers: chatPartnerId }
  });

  res.redirect('/chat');
});

app.post('/chat/:userId/unblock', async (req, res) => {
  const currentUserId = req.user._id;
  const chatPartnerId = req.params.userId;

  await User.findByIdAndUpdate(currentUserId, {
    $pull: { blockedUsers: chatPartnerId }
  });

  res.redirect(`/chat/${chatPartnerId}`);
});

app.get('/chat/:userId', isLoggedIn, async (req, res) => {
  const currentUserId = req.user._id;
  const chatPartnerId = req.params.userId;

  const messages = await Message.find({
    $or: [{ sender: currentUserId }, { receiver: currentUserId }]
  }).populate('sender receiver');

  const contactMap = new Map();
  messages.forEach(msg => {
    const otherUser = msg.sender._id.toString() === currentUserId.toString()
      ? msg.receiver
      : msg.sender;
    contactMap.set(otherUser._id.toString(), otherUser);
  });

  const contacts = Array.from(contactMap.values());
  const chatPartner = await User.findById(chatPartnerId);
  const chatPartnerBlockedMe = chatPartner.blockedUsers?.includes(currentUserId);

  const chatMessages = await Message.find({
    $or: [
      { sender: currentUserId, receiver: chatPartnerId },
      { sender: chatPartnerId, receiver: currentUserId }
    ]
  }).sort({ timestamp: 1 }).populate('sender');

  const user = await User.findById(currentUserId);
  const isBlocked = user.blockedUsers?.includes(chatPartnerId);

  res.render('chat', {
    currentUserId,
    chatPartnerId,
    chatPartnerName: chatPartner.username,
    messages: chatMessages,
    contacts,
    isBlocked,
    chatPartnerBlockedMe
  });
});

app.get('/chat', isLoggedIn, async (req, res) => {
  const currentUserId = req.user._id;

  const messages = await Message.find({
    $or: [{ sender: currentUserId }, { receiver: currentUserId }]
  }).populate('sender receiver');

  const contactMap = new Map();
  messages.forEach(msg => {
    const otherUser = msg.sender._id.toString() === currentUserId.toString()
      ? msg.receiver
      : msg.sender;
    contactMap.set(otherUser._id.toString(), otherUser);
  });

  const contacts = Array.from(contactMap.values());
  const chatPartner = contacts[0];
  const chatPartnerBlockedMe = chatPartner?.blockedUsers?.includes(currentUserId);
  let chatMessages = [];
  let isBlocked = false;

  if (chatPartner) {
    chatMessages = await Message.find({
      $or: [
        { sender: currentUserId, receiver: chatPartner._id },
        { sender: chatPartner._id, receiver: currentUserId }
      ]
    }).sort({ timestamp: 1 }).populate('sender');

    const user = await User.findById(currentUserId);
    isBlocked = user.blockedUsers?.includes(chatPartner._id);
  }

  res.render('chat', {
    currentUserId,
    chatPartnerId: chatPartner?._id || null,
    chatPartnerName: chatPartner?.username || '',
    messages: chatMessages,
    contacts,
    isBlocked,
    chatPartnerBlockedMe
  });
});

app.get("/", (req, res) => {
  res.render("home");
});

// =============================================================================
// PDF LIBRARY ROUTES — Phase 9 (Digital Resource System)
// =============================================================================

// GET /pdfs — list all PDFs with optional filter
app.get("/pdfs", catchAsync(async (req, res) => {
  const { type, dept, q } = req.query;
  const filter = {};
  if (type && type !== "all") filter.resource_type = type;
  if (dept) filter.department = new RegExp(dept, "i");
  if (q) filter.$text = { $search: q };

  const pdfs = await Pdf.find(filter).sort({ created_at: -1 }).limit(50);
  // Pass the canonical IIT ISM department list so the filter UI can render
  // a dropdown instead of a free-text input. Free text was producing zero-
  // result queries from typos ("ECE" vs "Electronics" vs "Electronic Eng")
  // — a closed list eliminates that whole class of failure.
  res.render("pdfs/index", {
    pdfs,
    query: req.query,
    departments: IITISM_DEPARTMENTS,
  });
}));

// GET /pdfs/new — upload form.
// The old distinct('course')/distinct('department') autofill has been replaced
// by the canonical IIT ISM catalogue: hardcoded 17-department list + the
// /api/courses?dept=<code> endpoint populates the course dropdown client-side.
app.get("/pdfs/new", isLoggedIn, (req, res) => {
  res.render("pdfs/new", { departments: IITISM_DEPARTMENTS });
});

// POST /pdfs — upload a new PDF
//
// Pipeline (replaces the old multer-storage-cloudinary direct upload):
//   1. multer stores the upload in memory (uploadPdfMemory)
//   2. ensurePdfFitsCloudinary() bounces the buffer to Python's
//      /compress-pdf if size > 9.5 MB; lossless deflate keeps text
//      extractable for the curriculum matcher.
//   3. uploadBufferToCloudinary() pushes the (possibly-compressed)
//      buffer to Cloudinary via the SDK and returns a result with
//      `secure_url` and `public_id` mirroring the old multer fields.
//   4. Pdf doc is saved with the URL + public_id from step 3.
//   5. /embed-pdf is fired async to generate the vector + chapters.
//
// User-facing behaviour: a 25 MB textbook upload that previously
// failed against Cloudinary's 10 MB cap now silently compresses and
// succeeds. A 60 MB scan that even compression can't shrink fails
// with a friendly "use a desktop tool to compress further" message
// instead of an opaque Cloudinary error.
app.post("/pdfs", isLoggedIn, uploadPdfMemory.single("pdf"), catchAsync(async (req, res) => {
  const {
    title, subject, course, department, professor, resource_type, description,
    // Resource-type-specific extras. Form submits empty strings for fields
    // not relevant to the chosen type; Mongoose coerces "" to default below.
    semester, topic, exam_type, year,
    // Autofilled from Google Books on the upload form. Blank string if the
    // user didn't pick a candidate — schema defaults to "" in that case and
    // the PDF card will render a generic icon instead of a cover thumbnail.
    cover_url
  } = req.body;

  if (!req.file) {
    req.flash("error", "Please select a PDF file to upload.");
    return res.redirect("/pdfs/new");
  }

  // --- Compression + Cloudinary upload ---------------------------------
  let cloudinaryResult;
  try {
    const finalBuffer = await ensurePdfFitsCloudinary(req.file.buffer, req.file.originalname);
    cloudinaryResult = await uploadBufferToCloudinary(finalBuffer, "bookswap_pdfs", req.file.originalname);
  } catch (err) {
    // userFacing flag = compression failed AND user can act on the message.
    // Anything else is a server bug — don't leak the raw error.
    const msg = err.userFacing
      ? err.message
      : "Could not upload PDF. Please try again or use a smaller file.";
    console.error("PDF upload pipeline error:", err.message);
    req.flash("error", msg);
    return res.redirect("/pdfs/new");
  }

  // Coerce numeric fields safely — empty strings would otherwise fail the
  // Number cast and throw a Mongoose validation error.
  const semesterNum = semester && !isNaN(parseInt(semester, 10)) ? parseInt(semester, 10) : null;
  const yearNum     = year     && !isNaN(parseInt(year, 10))     ? parseInt(year, 10)     : null;

  const pdf = new Pdf({
    title,
    subject,
    course,
    department,
    professor,
    resource_type: resource_type || "notes",
    semester:  semesterNum,
    topic:     topic || "",
    exam_type: exam_type || "",
    year:      yearNum,
    description,
    cloudinary_url: cloudinaryResult.secure_url,
    cloudinary_public_id: cloudinaryResult.public_id,
    cover_url: cover_url || "",
    uploadedBy: req.user._id
  });

  await pdf.save();

  // Trigger Python service to generate embedding for this PDF
  const aiUrl = process.env.AI_SERVICE_URL || "http://127.0.0.1:8001";
  try {
    await axios.post(`${aiUrl}/embed-pdf`, { pdf_id: String(pdf._id) });
  } catch (e) {
    // Non-blocking — embedding is best-effort
    console.warn("Could not embed PDF:", e.message);
  }

  req.flash("success", "PDF uploaded successfully!");
  res.redirect(`/pdfs/${pdf._id}`);
}));

// GET /pdfs/:id — view a single PDF
app.get("/pdfs/:id", catchAsync(async (req, res) => {
  const pdf = await Pdf.findById(req.params.id).populate("uploadedBy", "username");
  if (!pdf) {
    req.flash("error", "PDF not found.");
    return res.redirect("/pdfs");
  }
  res.render("pdfs/show", { pdf });
}));

// DELETE /pdfs/:id — remove a PDF
app.delete("/pdfs/:id", isLoggedIn, catchAsync(async (req, res) => {
  const pdf = await Pdf.findById(req.params.id);
  if (!pdf) {
    req.flash("error", "PDF not found.");
    return res.redirect("/pdfs");
  }
  if (!pdf.uploadedBy.equals(req.user._id)) {
    req.flash("error", "You do not have permission to delete this PDF.");
    return res.redirect(`/pdfs/${req.params.id}`);
  }
  // Delete from Cloudinary
  try {
    const { cloudinary: cld } = require("./cloudinary");
    await cld.uploader.destroy(pdf.cloudinary_public_id, { resource_type: "raw" });
  } catch (e) {
    console.warn("Cloudinary delete error:", e.message);
  }
  await Pdf.findByIdAndDelete(req.params.id);
  req.flash("success", "PDF deleted.");
  res.redirect("/pdfs");
}));

// =============================================================================
// CURRICULUM MATCHING ROUTE — Phase 10
// Upload a lecture plan PDF → get topic-to-book matches from Python service
// =============================================================================

app.get("/curriculum", isLoggedIn, catchAsync(async (req, res) => {
  // Show the upload form alongside a list of the user's previously saved
  // curricula, newest first. If this is the user's first visit, the list is
  // just empty — the upload form still works identically.
  const saved = await Curriculum.find({ user_id: req.user._id })
    .sort({ created_at: -1 })
    .select("course_name course_code department pdf_filename created_at parsed_result.n_units_parsed")
    .lean();
  res.render("curriculum/upload", { saved });
}));

app.post("/curriculum", isLoggedIn, uploadPdf.single("pdf"), catchAsync(async (req, res) => {
  if (!req.file) {
    req.flash("error", "Please upload a lecture plan PDF.");
    return res.redirect("/curriculum");
  }

  const aiUrl = process.env.AI_SERVICE_URL || "http://127.0.0.1:8001";

  try {
    // Download the uploaded PDF from Cloudinary and forward to Python service
    const pdfResponse = await axios.get(req.file.path, { responseType: "arraybuffer" });
    const formData = new FormData();
    formData.append("file", Buffer.from(pdfResponse.data), {
      filename: req.file.originalname || "lecture_plan.pdf",
      contentType: "application/pdf"
    });

    // Long timeout (90 s) because the first curriculum upload after the
    // Python service has been idle has to absorb several stacked latencies:
    //
    //   - Render free-plan cold-start (up to 30 s to wake the container)
    //   - First-time SentenceTransformer model load (~10-15 s, lazy-loaded
    //     on first embedding call — see app/embeddings.py)
    //   - OCR pass on scanned-PDF lecture plans (~5-10 s per page)
    //   - Curriculum pipeline itself (parse + book judge + chapter judge,
    //     ~5-10 s of Groq calls)
    //
    // 30 s was the original timeout — it routinely fired before the Python
    // pipeline finished even on warm calls when the PDF was scanned. 90 s
    // gives comfortable headroom; subsequent warm calls return in 5-10 s
    // and don't notice the higher ceiling.
    const aiResponse = await axios.post(`${aiUrl}/curriculum`, formData, {
      headers: formData.getHeaders(),
      timeout: 90000,
      // Without these two, axios buffers the whole multipart upload AND
      // the whole response in memory before the request even leaves Node,
      // which can pin Render's free-plan worker on large scanned PDFs.
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    const matchData = aiResponse.data;

    // --- Snapshot-save for profile history ---------------------------------
    // Persist the parsed result so the student can revisit it from their
    // profile. We only save when the Python service actually returned a
    // usable result — if matchData.error is set, there's nothing worth
    // keeping in history. Saving still continues to the render path either
    // way, so errors are displayed to the user normally.
    let savedDoc = null;
    if (!matchData.error) {
      try {
        savedDoc = await Curriculum.create({
          user_id:        req.user._id,
          course_name:    matchData.course_name || "",
          course_code:    matchData.course_code || "",
          department:     matchData.department  || "",
          pdf_filename:   req.file.originalname || "",
          parsed_result:  matchData,
          prompt_version: matchData.prompt_version || "",
        });
      } catch (saveErr) {
        // Don't block the user's result view on a history-save failure.
        // Log it and carry on — the student still sees their matches.
        console.warn("Curriculum history save failed:", saveErr.message);
      }
    }

    // NOTE: don't pass a local called `filename` — EJS treats that key as
    // reserved (it's the internal template path used for error messages),
    // and our value gets silently overridden. Use `uploadedFilename` instead.
    res.render("curriculum/results", {
      matchData,
      uploadedFilename: req.file.originalname,
      savedCurriculum: savedDoc,   // null when save was skipped; results.ejs
                                   // uses this to decide whether to show the
                                   // "saved to profile" banner / delete button
    });
  } catch (e) {
    console.error("Curriculum match error:", e.message);
    req.flash("error", "Could not process the lecture plan. Please try again.");
    res.redirect("/curriculum");
  }
}));

// --- Saved curriculum history ------------------------------------------------
// GET /curriculum/history — full list of this user's saved runs
// GET /curriculum/:id     — render a single saved run through results.ejs
// DELETE /curriculum/:id  — owner-only delete (BOLA check: user_id must match)
// -----------------------------------------------------------------------------

// /curriculum/history is an alias for /curriculum — the upload page already
// renders the user's saved list below the upload form. Keeping the URL so
// external links / profile menus can deep-link to "history" without a 404.
app.get("/curriculum/history", isLoggedIn, (req, res) => {
  res.redirect("/curriculum");
});

app.get("/curriculum/:id", isLoggedIn, catchAsync(async (req, res) => {
  const doc = await Curriculum.findById(req.params.id).lean();
  if (!doc) {
    req.flash("error", "Saved curriculum not found.");
    return res.redirect("/curriculum");
  }
  // BOLA guard — only the owner can read. Without this, any logged-in user
  // could GET /curriculum/<someone-else's-id> and see their syllabus match.
  if (String(doc.user_id) !== String(req.user._id)) {
    req.flash("error", "You do not have access to that saved curriculum.");
    return res.redirect("/curriculum");
  }
  res.render("curriculum/results", {
    matchData:        doc.parsed_result || {},
    uploadedFilename: doc.pdf_filename || "",
    savedCurriculum:  doc,    // enables the "saved on <date>" banner + delete
  });
}));

app.delete("/curriculum/:id", isLoggedIn, catchAsync(async (req, res) => {
  const doc = await Curriculum.findById(req.params.id);
  if (!doc) {
    req.flash("error", "Saved curriculum not found.");
    return res.redirect("/curriculum");
  }
  if (String(doc.user_id) !== String(req.user._id)) {
    req.flash("error", "You do not have permission to delete that.");
    return res.redirect("/curriculum");
  }
  await Curriculum.findByIdAndDelete(req.params.id);
  req.flash("success", "Saved curriculum removed.");
  res.redirect("/curriculum");
}));

// =============================================================================
// AI CHAT PROXY — POST /api/ai-chat
//
// The chat widget on every page POSTs here instead of calling the Python
// FastAPI service directly. Two reasons this proxy is non-negotiable in
// production:
//
//   1. Security. user_id is read from req.user._id (Passport's server-side
//      session) and forwarded to Python. If the browser called Python
//      directly, user_id would be a client-supplied field — trivially
//      forgeable, breaking any per-user feature (taste vector, history).
//      With the proxy the Python service can trust user_id as ground truth
//      coming from an authenticated Node session.
//
//   2. Deployability. On Render the Python service has its own URL
//      (process.env.AI_SERVICE_URL). Hard-coding it in the browser-side
//      EJS would mean every redeploy with a new URL needs a frontend
//      change. Routing through the same origin keeps the browser code
//      origin-relative ("/api/ai-chat").
//
// Pattern mirrors the existing /search and /curriculum routes that also
// proxy to the Python service.
// =============================================================================
app.post("/api/ai-chat", isLoggedIn, catchAsync(async (req, res) => {
  const { message, session_id } = req.body;
  if (!message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "Message is required" });
  }

  const aiUrl = process.env.AI_SERVICE_URL || "http://127.0.0.1:8001";

  // 60 s ceiling. Same cold-start arithmetic as the /curriculum proxy
  // (Render wake + lazy model load on first embedding) but no OCR step,
  // so the upper bound is shorter. AbortController is the standard
  // pattern for fetch — fetch itself has no timeout option in Node.
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 60000);

  try {
    const aiResponse = await fetch(`${aiUrl}/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        message: message.trim(),
        session_id: session_id || null,
        // user_id comes from the server-side Passport session — NOT from
        // anything the browser sent. This is the security boundary.
        user_id: req.user._id.toString(),
      }),
    });

    if (!aiResponse.ok) {
      const text = await aiResponse.text();
      console.warn("AI chat upstream error:", aiResponse.status, text);
      return res.status(502).json({
        response: "Sorry, the AI service is unavailable right now. Try again in a moment.",
      });
    }

    const data = await aiResponse.json();
    return res.json(data);
  } catch (err) {
    console.error("AI chat proxy error:", err.message);
    // Differentiate AbortController timeout from other failures so the
    // frontend can show "wake-up in progress" instead of a generic error
    // when the Python service is just cold-starting.
    if (err.name === "AbortError") {
      return res.status(504).json({
        response: "The AI service is waking up — please send your message again in a few seconds.",
      });
    }
    return res.status(502).json({
      response: "Sorry, I couldn't reach the AI service. Try again in a moment.",
    });
  } finally {
    clearTimeout(tid);
  }
}));

app.all("*", (req, res, next) => {
  next(new ExpressError("Page Not Found", 404));
});

app.use((err, req, res, next) => {
  const { statusCode = 500 } = err;
  if (!err.message) err.message = "OH NO Something Went Wrong!";
  res.status(statusCode).render("error", { err });
});


const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});
const port = process.env.PORT || 3000;

server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

socket.on("sendMessage", async ({ senderId, receiverId, message }) => {
  try {
    const newMsg = new Message({ sender: senderId, receiver: receiverId, message });
    await newMsg.save();

    const receiver = await User.findById(receiverId);
    if (!receiver.blockedUsers?.includes(senderId)) {
      io.emit("receiveMessage", { senderId, receiverId, message });
    }
  } catch (err) {
    console.error("Error sending message:", err);
  }
});

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
  });
});
