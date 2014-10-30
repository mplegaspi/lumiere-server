/**
 * Main application logic for Lumiere Meteor app.
 */

// Place hold some variables
var chroma, Twitter, twitter;

// Persistant data stores
var Colors = new Meteor.Collection('colors');

// Allow a settings file to override defaults
Meteor.settings = _.extend({
  'name': 'Lumière',
  'phone': '+1 651 400 1501',
  'lights': 10,
  'twitterFilter': ['lumierebot', 'lumierelights', 'lumierelighting']
}, Meteor.settings);


// Shared objects across client and server.
// Meteor.lumiere.colors comes in from colors.js
Meteor.lumiere = Meteor.lumiere || {};

// Shared methods that should not be called async
Meteor.lumiere.fillColor = function(color) {
  var colors = [];
  var i;

  // Repeat colors if longer than needed
  if (!_.isUndefined(color) && _.isObject(color) && color.colors.length < Meteor.settings.lights) {
    for (i = 0; i < Meteor.settings.lights; i++) {
      colors.push(color.colors[i % color.colors.length]);
    }
    color.colors = colors;
  }
  return color;
};


// Client side only.  Multiple templates are used
// as Meteor ends up rerendering everything when
// one value is updated and can be very slow.
if (Meteor.isClient) {
  // Subscribe to data
  Meteor.subscribe('colors-recent');

  // Status allows for a simple icon to show if the client
  // is connected to the server
  Template.header.helpers({
    status: function() {
      return Meteor.status().status;
    },
    name: Meteor.settings.name
  });

  // The current selection of lights
  Template.lights.helpers({
    current: function() {
      var recent = Colors.find({}, { sort: { timestamp: -1 }, limit: 1 }).fetch()[0];

      if (!_.isUndefined(recent)) {
        recent.input = recent.input.split(',').join(', ');
      }

      recent =  Meteor.lumiere.fillColor(recent);
      length = recent.colors.length;
      recent.lightWidth = (length === 0) ? 0 : (100 / length) - 0.00001;
      return recent;
    }
  });

  // About sections
  Template.about.helpers({
    phone: Meteor.settings.phone,
    name: Meteor.settings.name
  });

  // All those colors!
  Template.input.helpers({
    colorList: Meteor.lumiere.colors
  });

  // Events handled in the input template.
  Template.input.events({
    // Submit new colors
    'submit .color-input-form': function(e) {
      e.preventDefault();
      var $form = $(e.currentTarget);

      Meteor.call('addColor', $form.find('#color-input-text').val(), function(error, response) {
        if (error) {
          throw new error;
        }
        else {
          $form.find('#color-input-text').val('');
        }
      });
    },
    // Add colors to input
    'click li.color-choice': function(e) {
      e.preventDefault();
      var $color = $(e.currentTarget);
      var $input = $('#color-input-text');
      var current = $input.val().split(',');
      var name = $color.data('name');
      current.push(name);

      current = _.filter(current, function(c) {
        return (!!c);
      });
      $input.val(current.join(','));
    }
  });
}


// Server side only.  Saving and processing colors.  Mostly we are just adding
// some methods that can be shared with the client
if (Meteor.isServer) {
  // "npm" packages
  chroma = Meteor.npmRequire('chroma-js');

  // Connect to twitter
  if (_.isObject(Meteor.settings.twitterAuth)) {
    Twitter = Meteor.npmRequire('twitter');
    twitter = new Twitter(Meteor.settings.twitterAuth);
  }

  // Startup
  Meteor.startup(function() {
    // Create subscriptions to data for the client
    Meteor.publish('colors-recent', function publishFunction() {
      return Colors.find({}, { sort: { timestamp: -1 }, limit: 1 });
    });

    // Methods that can be shared on both server and client
    Meteor.methods({
      // Turn a string into a color
      findColor: function(input) {
        var names = _.pluck(Meteor.lumiere.colors, 'colorName');
        var color = false;
        var colors = [];
        var found;
        var r;

        // First see if Chroma can handle the input, if that fails
        // do a look up of custom colors.
        //
        // We used to choose one at random, but handling bad language
        // made me rethink handling this at all.
        try {
          color = chroma(input);
          color = color.hex();
        }
        catch (e) {
          found = names.indexOf(input);

          if (found !== -1) {
            color = Meteor.lumiere.colors[found].colors;
          }
          else {
            return false;
          }
        }

        // Turn values into hex
        if (_.isString(color)) {
          color = chroma(color).hex();
        }
        else if (_.isArray(color)) {
          color.forEach(function(c) {
            colors.push(chroma(c).hex());
          });
          color = colors;
        }

        return color;
      },

      // Turn input into a set of colors
      makeColors: function(input) {
        var colors = [];
        var inputs = [];
        var outputs = [];
        var found;

        _.each(input.trim().split(','), function(c) {
          c = c.trim().replace(/\W/g, '').toLowerCase();
          if (c.length > 0) {
            found = Meteor.call('findColor', c);

            if (_.isString(found)) {
              colors.push(found);
              inputs.push(c);
            }
            else if (_.isArray(found)) {
              found.forEach(function(f) {
                colors.push(f);
              });
              inputs.push(c);
            }
          }
        });

        return {
          input: inputs.join(','),
          colors: colors
        };
      },

      // Save colors to data-store
      saveColors: function(input, colors) {
        Colors.insert({
          timestamp: (new Date()).getTime(),
          input: input,
          colors: colors
        });
      },

      // Wrapper for make and save
      addColor: function(input) {
        var colors = Meteor.call('makeColors', input);

        if (colors.colors.length > 0) {
          Meteor.call('saveColors', colors.input, colors.colors);
        }
      }
    });
  });
}


// Twitter streaming input handling
if (_.isObject(Meteor.settings.twitterAuth) && Meteor.settings.twitterFilter) {
  twitter.stream('filter', { track: Meteor.settings.twitterFilter }, function(stream) {
    // Since we are out of the context of Meteor and Fiber, we have to wrap
    // this.
    stream.on('data', Meteor.bindEnvironment(function(data) {
      var text;

      // Data in, strip out non-word stuff and send through
      if (_.isObject(data) && data.text) {
        text = data.text.replace(/(#[A-Za-z0-9]+)|(@[A-Za-z0-9]+)|([^0-9A-Za-z, \t])|(\w+:\/\/\S+)/ig, ' ');
        if (text.length > 2) {
          Meteor.call('addColor', text);
        }
      }
    }));

    // Handle error
    stream.on('error', Meteor.bindEnvironment(function(error) {
      if (error.source) {
        console.error(error.source);
      }
      else {
        console.error(error.stack);
      }
    }));

  });
}


// "API" routing

// Routing for text input.  Can test locally with something like:
// curl --data "Body=blue" -X POST http://localhost:3000/api/colors/twilio
Router.route('incoming-twilio', {
  path: '/api/colors/twilio',
  where: 'server',
  action: function() {
    // Example input from Twilio
    /*
    { AccountSid: 'XXXXXX',
    MessageSid: 'XXXXXX',
    Body: 'green',
    ToZip: '55045',
    ToCity: 'LINDSTROM',
    FromState: 'GA',
    ToState: 'MN',
    SmsSid: 'XXXXXXX',
    To: '+16514001501',
    ToCountry: 'US',
    FromCountry: 'US',
    SmsMessageSid: 'XXXXX',
    ApiVersion: '2010-04-01',
    FromCity: 'ATLANTA',
    SmsStatus: 'received',
    NumMedia: '0',
    From: '+177059XXXXX',
    FromZip: '30354' }
    */

    // Responses
    var responses = [
      'Thanks for your input; your color(s) should show up in a few seconds.',
      'Yay! More colors! Might take a moment to update those colors for you.',
      'Our robots are working hard to get those colors just right for you.',
      'Wait for it... Bam! Colors!'
    ];

    // Should return a TwiML document.
    // https://www.twilio.com/docs/api/twiml
    if (this.request.body && this.request.body.Body) {
      Meteor.call('addColor', this.request.body.Body);
    }

    // Return some TwiML
    this.response.writeHead(200, {
      'Content-Type': 'text/xml'
    });
    this.response.end('<?xml version="1.0" encoding="UTF-8" ?> <Response> <Sms> ' + _.sample(responses) + ' -' + Meteor.settings.name + '</Sms> </Response>\n');
  }
});

// Routing for color api output
Router.route('outgoing-colors', {
  path: '/api/colors',
  where: 'server',
  action: function() {
    var thisRoute = this;
    var color = Colors.find({}, { sort: { timestamp: -1 }}).fetch()[0];

    // Output other formats such as hex, rgb, css
    if (_.isObject(this.params) && this.params.format) {
      color.colors = _.map(color.colors, function(c, ci) {
        var o = chroma(c);
        if (_.isFunction(o[thisRoute.params.format])) {
          return o[thisRoute.params.format]();
        }
        return c;
      });
    }

    // FastLED wants to use a hex format like 0x123456 so we provide this for
    // easier processing
    if (_.isObject(this.params) && this.params.format === 'hex0') {
      color.colors = _.map(color.colors, function(c, ci) {
        return chroma(c).hex().replace('#', '0x');
      });
    }

    // Handle limit
    if (_.isObject(this.params) && parseInt(this.params.limit, 10) > 0) {
      color.colors = _.first(color.colors, parseInt(this.params.limit, 10));
    }

    // Remove input, as this can help use less memory for client
    if (_.isObject(this.params) && this.params.noInput === 'true') {
      color.input = undefined;
    }


    // Write out
    this.response.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Document-ID': color._id
    });
    this.response.end(JSON.stringify(color) + '\n');
  }
});



// Iron router needs a default route
Router.route('home', {
  path: '*'
});
