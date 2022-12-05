const Joi = require('joi');
module.exports.bookSchema =Joi.object({
    book:Joi.object({
        title:Joi.string().required(),
        author:Joi.string().required(),
        genre:Joi.string().required(),
        description:Joi.string().required(),
        price:Joi.number().required().min(0),
    }).required(),
    deleteImages:Joi.array()
})

// module.exports.userSchema =Joi.object({
//     book:Joi.object({
//         email:Joi.string().required(),
//        password:Joi.string().required(),
//         contact:Joi.string().required(),
//         address:Joi.string().required(),
       
//     }).required(),
    
// })


module.exports.reviewSchema=Joi.object({
    review:Joi.object({
        rating:Joi.number().required(),
        body: Joi.string().required()
    }).required()
})
module.exports.orderSchema=Joi.object({
    order:Joi.object({
        amount:Joi.string().required(),
        payee:Joi.string().required(),
        purchase:Joi.string().required(),
        address:Joi.string().required(),
        contact:Joi.string().required(),

    }).required()
})