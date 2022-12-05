const ExpressError = require('./utils/ExpressError');
const { bookSchema,reviewSchema } = require('./schemas');
const Book = require('./models/books');
const Review = require('./models/review');

module.exports.isLoggedIn=(req,res,next)=>{
 console.log("REQ.USER.......",req.user);

    if(!req.isAuthenticated()){
        console.log('login to continue');
        req.flash('error','u must be signed in first');
        req.session.returnTo=req.path;
        console.log(req.session.returnTo);
        return res.redirect('/login');
    }

    else{
        req.session.returnTo = req.originalUrl;
        console.log(req.session.returnTo);
        // res.redirect(req.session.returnTo);
        next(); 
    }
   
}


module.exports.isLoggedIn =(req,res,next)=>{
    req.session.returnTo = req.originalUrl;
    if(!req.isAuthenticated()){
        req.flash('error','you must be signed in!');
        return res.redirect('/login');
    }
    next();
}

module.exports.isAuthor = async(req,res,next)=>{
    const{id} = req.params;
    const book=await Book.findById(id);
    if(!book.owner.equals(req.user._id)){
        req.flash('error','you cant do that');
        return res.redirect(`/books/${id}`);
    }
    next();
}
module.exports.validateBook = (req, res, next) => {
    const { error } = bookSchema.validate(req.body.book);
    if (error) {
        const msg = error.details.map(el => el.message).join(',')
        throw new ExpressError(msg, 400)
    } else {
        next();
    }
}

module.exports.validateReview = (req, res, next) => {
    const { error } = reviewSchema.validate(req.body);
    if (error) {
        const msg = error.details.map(el => el.message).join(',')
        throw new ExpressError(msg, 400)
    } else {
        next();
    }
}


module.exports.isReviewAuthor = async(req,res,next)=>{
    const{id,reviewId} = req.params;
    const review =await Review.findById(reviewId);
    if(!review.author.equals(req.user._id)){
        req.flash('error','you cant do that');
        return res.redirect(`/books/${id}`);
    }
    next();
}