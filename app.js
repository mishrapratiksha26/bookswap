if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}
const mongoose = require("mongoose");
const path = require("path");
const Joi = require("joi");

const { bookSchema, reviewSchema } = require("./schemas");
const express = require("express");
const {cloudinary} =require("./cloudinary")
const ejsMate = require("ejs-mate");
const catchAsync = require("./utils/catchAsync");
const ExpressError = require("./utils/ExpressError");
const User = require("./models/users");
const Book = require("./models/books");
const Order = require("./models/order");
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
} = require("./middleware");
const multer = require("multer");
const { storage } = require("./cloudinary/index");
const upload = multer({ storage });
const Review = require("./models/review");

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
  console.log("Database connected");
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
app.get(
  "/books",
  catchAsync(async (req, res) => {
    const books = await Book.find({});
    console.log(books.images);
    console.log(books);
    //   console.log(currentUser);
    res.render("books/index", { books });
  })
);

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

    const books = await Book.find({ owner: `${user._id}` });
    // console.log("library is", books);
    res.render("users/profile", { user, books });
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

// app.get("/books/search",(req,res)=>{
//   console.log(req.query)
//   res.render("books/search")
// })
// app.post("/books/search?search=:query",(req,res)=>{

//   console.log("211111111111111111111",req.query)
// })
// app.get("/books/search?search=:query",catchAsync(async(req,res)=>{
//   const books = await Book.find({});
//   console.log(books)
//   const book =await book.find({$pull:{query:{title:{$in:req.body}}}})
//   res.render("/books")
// }))




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
    // console.log("BOOK ISSSSSSSSSSSS", book);
    // console.log(book.images.url);
    res.render("books/show", { book });
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
    if(req.body.deleteImages){
      for (let filename of req.body.deleteImages){
        await cloudinary.uploader.destroy(filename);
      }
    await book.updateOne({$pull:{images:{filename:{$in:req.body.deleteImages}}}})
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
    res.render("users/order", { book, user});
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
  catchAsync(async (req, res) => {
    const { id, reviewId } = req.params;
    Book.findByIdAndUpdate(id, { $pull: { reviews: reviewId } });
    await Review.findByIdAndDelete(req.params.reviewId);
    req.flash("success", "Review deleted!");
    res.redirect(`/books/${id}`);
  })
);

// app.get('/books/search', async (req, res) => {
//   const { bookName } = req.query;
//   const books = await Book.find({ $text: { $search: { title: bookName } } });
//   // res.render('restaurants', { restaurants });
//   console.log("SEARCHED FOR",books)
// })




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

const port = process.env.PORT || 3000
app.listen(port, () => {
  console.log(`Serving on port ${port}`);
});
