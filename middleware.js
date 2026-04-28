const ExpressError = require('./utils/ExpressError');
const { bookSchema,reviewSchema } = require('./schemas');
const Book = require('./models/books');
const Review = require('./models/review');

module.exports.isLoggedIn = (req, res, next) => {
    if (!req.isAuthenticated()) {
        // AJAX / JSON callers (chat widget, /api/* routes) cannot follow a
        // 302 redirect meaningfully — the browser silently fetches the
        // /login HTML and the calling JavaScript chokes on `response.json()`,
        // surfacing as a generic "Sorry, something went wrong" with no
        // hint of the real cause. The pilot user-test session lost ~10
        // minutes to exactly this confusion.
        //
        // Detect a programmatic caller via three signals (any one is enough):
        //   - the path starts with /api/  (our convention for JSON routes)
        //   - the request explicitly accepts JSON
        //   - the request was sent by fetch / XMLHttpRequest (X-Requested-With)
        //
        // For those callers, return a clean 401 JSON the frontend can render
        // as "please log in." Regular page navigations still get the original
        // flash + redirect behaviour so the login flow is unchanged.
        const isApiCaller =
            req.path.startsWith('/api/') ||
            (req.xhr) ||
            (req.headers.accept && req.headers.accept.includes('application/json')) ||
            (req.headers['x-requested-with'] === 'XMLHttpRequest');

        if (isApiCaller) {
            return res.status(401).json({
                error: 'not_authenticated',
                message: 'Please log in to use this feature.',
            });
        }

        req.session.returnTo = req.originalUrl;
        req.flash('error', 'You must be signed in first!');
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