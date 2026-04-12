const mongoose= require('mongoose');
const Schema = mongoose.Schema;

const BorrowRequestSchema = new Schema({
   book:{
    type:Schema.Types.ObjectId,
    ref:'Books'
    },
   borrower:{
    type:Schema.Types.ObjectId,
    ref:'User'
   },
   status:{
      type:String,
      enum:['pending','approved','rejected','returned'],
      default:'pending'
   },
   owner:{
      type:Schema.Types.ObjectId,
      ref:'User'
   },
    requestDate:{
       type:Date,
       default:Date.now
    },
    returnDate:Date
});

module.exports=mongoose.model("BorrowRequest",BorrowRequestSchema); 