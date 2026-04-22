const mongoose= require('mongoose');
// const User = require('./users');
const Review= require('./review')
const Schema = mongoose.Schema;

const ImageSchema=new Schema({
   url:String,
   filename:String
});

ImageSchema.virtual('thumbnail').get(function(){
   return this.url.replace('/upload','/upload/w_150');
});

const BookSchema = new Schema({
   title:{
        type:String,
        required:true,
    },
   author:{
    type:String,
    required:true
   },
   genre:{
    type:String
   },
   images:[
      ImageSchema
],
   description:{
      type:String,
      required:true,
   },
   price:{
      type:Number,
      required:true
   },
   owner:{
      type:Schema.Types.ObjectId,
      ref:'User'
   },
   reviews:[{
      type:Schema.Types.ObjectId,
      ref:'Review'
   }],
   available: { type: Boolean, default: true },

   // ---------------------------------------------------------------
   // Academic metadata — optional fields, filled only for educational
   // books (when owner picks genre = EDUCATIONAL on the upload form).
   // Enables filtering by course / department / year on the index page
   // and powers the curriculum matcher's book-search by department.
   // ---------------------------------------------------------------
   course:           { type: String },   // e.g. "MCO502 - Optimization Techniques"
   department:       { type: String },   // e.g. "MC" (IIT ISM department code)
   publication_year: { type: Number },   // textbook copyright year, e.g. 2017

   // ---------------------------------------------------------------
   // Physical study material beyond textbooks — a student may lend
   // out hand-written notes, printed lecture slides, or hard copies
   // of previous year question papers. Mirrors the Pdf schema so the
   // curriculum matcher and upload forms treat physical vs digital
   // resources uniformly.
   //
   // resource_type defaults to "textbook" (the common case for the
   // books collection); notes/previous_papers/reference are opt-in
   // when a student lists loose academic material.
   // ---------------------------------------------------------------
   resource_type: {
      type: String,
      enum: ["textbook", "notes", "previous_papers", "reference"],
      default: "textbook"
   },
   // For resource_type="notes":
   semester: { type: Number, min: 1, max: 10, default: null },
   topic:    { type: String, trim: true, default: "" },
   // For resource_type="previous_papers": which exam, which year.
   // `year` is the EXAM year (2024 mid-sem), distinct from publication_year
   // (a textbook's copyright year). Both can be populated if ever relevant.
   exam_type: {
      type: String,
      enum: ["mid_sem", "end_sem", "quiz", "assignment", ""],
      default: ""
   },
   year: { type: Number, min: 2000, max: 2100, default: null },

   // ---------------------------------------------------------------
   // avg_rating: denormalised average of all reviews on this book.
   // Why denormalise: the books index page sorts/filters by rating.
   // Computing it via aggregation on every request = slow at scale.
   // Instead we update this field once, when a review is posted /
   // deleted (POST /books/:id/reviews route updates it).
   // Default 0 = "no reviews yet" — filter logic treats 0 as neutral.
   // ---------------------------------------------------------------
   avg_rating:       { type: Number, default: 0 }

});

// BookSchema.index({ title: "text", description: "text" })

BookSchema.post('findOneAndDelete',async function(doc){
   if(doc){
      await Review.deleteMany({
         _id:{
            $in:doc.reviews
         }
      })
   }
})


module.exports = mongoose.model('Books',BookSchema);