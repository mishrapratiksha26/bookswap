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
   course:           { type: String },   // e.g. "MCO502"
   department:       { type: String },   // e.g. "Mathematics and Computing"
   publication_year: { type: Number },   // e.g. 2017

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