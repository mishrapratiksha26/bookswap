if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}
const mongoose = require("mongoose");
const path = require("path");
const Joi = require("joi");
const BorrowRequest = require("./models/borrowrequest");
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

app.get("/books", catchAsync(async (req, res) => {
    const { query } = req.query;
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
                console.log("booksWithRatings:", booksWithRatings);
                const response = await fetch(`${process.env.AI_SERVICE_URL}/recommend-personal`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ books: booksWithRatings, top_k: 5 })
                });
                const data = await response.json();
                personalRecommendations = data.results;
                console.log("Personal recommendations data:", data);
                personalRecommendations = data.results;
              }
        } catch (err) {
            console.log("Personal recommendations failed:", err);
        }
    }
    
    const books = await Book.find({});
    res.render("books/index", { books, searchResults, query: query || "", personalRecommendations });
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
    const borrowRequests = await BorrowRequest.find({ 
      owner: user._id, 
      status: 'pending' 
    }).populate('book').populate('borrower');
    const myBorrowRequests = await BorrowRequest.find({ 
      borrower: user._id 
    }).populate('book').populate('owner');
    const borrowedBooks = await Book.find({ 
      _id: { $in: user.borrowedBooks } 
    });
    const lentBooks = await Book.find({
      owner: user._id,
      available: false
    });
    const activeLentRequests = await BorrowRequest.find({
      owner: user._id,
      status: 'approved'
    }).populate('book').populate('borrower');
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
  res.render("books/new");
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
        body: JSON.stringify({ book_id: book._id, top_k: 5 })
      });
      const data = await response.json();
      similarBooks = data.results;
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
    
    res.render("books/show", { book, currentUserId, ownerId, similarBooks, activeBorrowRequest, userBorrowRequest });
  })
);

app.post(
  "/books",
  isLoggedIn,
  validateBook,
  upload.array("image"),
  catchAsync(async (req, res) => {
    if (!req.body.book) throw new ExpressError("Invalid Book Data", 400);
    const book = new Book(req.body.book);
    book.images = req.files.map((f) => ({ url: f.path, filename: f.filename }));
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

app.post(
  "/books/:id/reviews",
  isLoggedIn,
  validateReview,
  catchAsync(async (req, res) => {
    const book = await Book.findById(req.params.id);
    const review = new Review(req.body.review);
    review.author = req.user._id;
    book.reviews.push(review);
    await review.save();
    await book.save();
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
    req.flash("success", "Review deleted!");
    res.redirect(`/books/${id}`);
  })
);

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
