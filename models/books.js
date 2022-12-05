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
   }]

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