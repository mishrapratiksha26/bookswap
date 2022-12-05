const mongoose=require('mongoose');
const Schema =mongoose.Schema;

const orderSchema =new Schema({
    amount: Number,
    purchase:{
    type:Schema.Types.ObjectId,
    ref:'Book'
    },
    payee:{
    type:Schema.Types.ObjectId,
    ref:'User'}
    
});

module.exports=mongoose.model("Order",orderSchema);