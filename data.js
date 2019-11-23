"use strict"

const Actions = {
  MOVE:"move",
  UNLOCK:"unlock",
  ATTACK:"attack",
  GET:"get",
  DROP:"drop",
  USE:"use",
  CAPTURE:"capture",  // TODO generic target action
  COUNT:"count",
  ACTIVATE:"activate"
};
const Events = {
  LOG:"log"
};
const Category = {
  DOORS:"doors",
  ITEMS:"items",
  ACTORS:"actors",
  ROOMS:"rooms",
  SPECIAL:"special"
};

class GameData {
  constructor(json) {
    Object.assign(this, json);
    this.transient = {};
    this.transient.byId = {};
  }

  getDefs(defType) {
    if(this.defs.hasOwnProperty(defType)) {
        return this.defs[defType];
    }
    throw Error("No defs type '" + defType + "'.")
  }

  getAll() {
    return asList(this.getCategoryMap(CATEGORY_ALL));
  }

  getCategoryMap(category) {
    return this.transient.byId[category];
  }

  getByCategoryId(category, id) {
    return this.transient.byId[category][id];
  }

  getPcs() {
    return this.actors.filter(actor => actor.ai === AI_PLAYER);
  }

  pcSelected() { // TODO selectedId
    return this.selected && this.getByCategoryId(Category.ACTORS, this.selected).isAlive();
  }

  isBusy(actorId) {
    var busyActors = this.scheduler.toArray().map((a)=>a.actor.id); // TODO non-actors
    return busyActors.includes(actorId);
  }
}

class Action {
    constructor(type, target, actor, duration, required) { // TODO swap target and actor
        this.type = type;
        this.target = target;
        this.actor = actor;
        if (!duration) {
          // TODO Something else
          this.duration = 5;
        } else {
          this.duration = duration;
        }

        this.source = actor.getActionMap()[type];

        for (let requirement of ["type", "actor"]) {
          if (!this[requirement]) {
            throw new Error("field" + requirement + " must be non null for type Action");
          }
        }
    }

    static byType(actions) {
      var aggregate = {};
      for (let next of actions){
        if (!next.hasOwnProperty(DEF_TYPE)) {
          throw Error("Typeless action in byType()");
        }
        if(!aggregate.hasOwnProperty(next.type)) {
          aggregate[next.type] = [];
        }
        aggregate[next.type].push(next);
      }
      return aggregate;
    }

    static getChoices(actor, gameData) {
        let out = [];
        let room = gameData.getByCategoryId(Category.ROOMS, actor.roomName);
        let actionMap = actor.getActionMap();
        let addIfSupported = (action)=>{
          if (actionMap[action.type] && action.isValid(gameData)) {
            out.push(action);
          }
        }
        if (room) {
          if(room.getItems() && actor.getItems().length < actor.inventory) {
            let items = room.getItems();
            for (let item of items) {
              addIfSupported(new Action(Actions.GET, item, actor));
            }
          }
          for (let doorId of room.doorIds) {
            let door = gameData.getByCategoryId(Category.DOORS, doorId)
              if (!door.locked) {
                addIfSupported(new Action(Actions.MOVE, door.other(room.id), actor));
              } else {
                // TODO If actor supported
                addIfSupported(new Action(Actions.UNLOCK, door, actor));
              }
          }
        }

        // Combat
        let actorsHere = [];
        for (let otherActor of gameData.actors ) {
          if (otherActor.roomName === actor.roomName
              && otherActor.id != actor.id) {
              addIfSupported(new Action(Actions.ATTACK, otherActor, actor));
              addIfSupported(new Action(Actions.CAPTURE, otherActor, actor));
          }
        }

        // Items
        if (actor.getItems()) {
          let items = actor.getItems();
          for (let item of items) {
            // addIfSupported(new Action(Actions.USE, item, actor));
            addIfSupported(new Action(Actions.DROP, item, actor));
          }
        }

        // For logic actors
        addIfSupported(new Action(Actions.COUNT, null, actor, 1));

        if (room) { // TODO deduplicate w/ above
          let specialsHere = room.getContained(Category.SPECIAL);
          for (let special of specialsHere) {
            if (special.floorAction) {
              let action = new Action(Actions.ACTIVATE, special, actor, 3);
              addIfSupported(action);
          }
        }
      }

        return out;
    }

    static handleAction(event, gameData) {
        let effects = [];
        let actor = event.actor;
        let actorRoom = gameData
            .getByCategoryId(Category.ROOMS, event.actor.roomName);
        let target = event.target;
        if (event.type === Actions.MOVE) {
            event.actor.roomName = event.target;
            // TODO fucking move fuck tshit ass
        } else if (event.type === Actions.UNLOCK) {
            event.target.locked = false;
        } else if (event.type === Actions.ATTACK) {
            let weapon = event.source;
            let targetWasAlive = target.isAlive();
            if (weapon) {
              target.hp -= weapon.damage;
              effects.push({msg:target.id + " is being wounded."}); // TODO ??? not OK??
              if(!weapon.nobleed) {
                // TODO bleed
              }
              if (targetWasAlive && !target.isAlive()) {
                effects.push({msg: target.id + " has collapsed."});
              }
            }
        } else if (event.type === Actions.GET) {
          let item = event.target;
          item.roomName = actor.id; // TODO do... something else
          actorRoom.transient.items = actorRoom.getItems().filter((thing)=>thing != item);
            event.actor.transient.items.push(event.target);
        } else if (event.type === Actions.DROP) {
          // Move item to room
          let item = event.target;
          item.roomName = actorRoom.id;
          event.actor.transient.items = event.actor.getItems().filter((thing)=>thing != item);
          actorRoom.transient.items.push(item);
        } else if (event.type === Actions.USE) {
          // TODO ...use it
        } else if (event.type === Actions.CAPTURE) {
          event.source.captive = target;
          target.roomName = VOID;
          gameData.actors.splice(gameData.actors.indexOf(target));
        } else if (event.type === Actions.COUNT) {
          actor.increment(gameData);
        } else if (event.type === Actions.ACTIVATE) {
          let targetObject =  event.target;
          if (targetObject.onActivated) { // TODO and it's a function
            targetObject.onActivated(event.source, gameData);
          }
        } else {
          throw Error("undefined action " + event)
        }
        this.log(event, gameData);
        for (let effect of effects) {
          this.log(effect, gameData);
        }
    }

    static log(event, gameData) {
      var log = document.getElementById("events");
      if (event.msg) {
        log.innerHTML = log.innerHTML + event.msg + "<br/>";
      } else {
        let eventText = event.getEventText(gameData);
        if (eventText) {
          log.innerHTML= log.innerHTML + (eventText + "<br/>");
        }
      }
    }

    static takeAction(actor, action, gameData) { // todo rename queue
        if (action.isValid(gameData)) {
          let speed = actor.speed ? actor.speed : 1;
          action.time = gameData.state.time + (action.duration * speed);
          gameData.scheduler.enqueue(action);
        } else {
          gameData.scheduler.enqueue(new Action(Events.LOG, "invalid action taken", 0));
        }
    }

    isValid(gameData) { // TODO must die
      if (!gameData) {throw new Error("NO MORE NULL GAMEDATA");}

      let actor = this.actor; // object
      let actionMap = actor.getActionMap();
      let target = this.target;

      if (!actionMap[this.type]) {
        return false;
      }
      if (!actor.takesActions()) {
        return false;
      }

      let actorRoom = gameData
          .getByCategoryId(Category.ROOMS, actor.roomName);

      switch(this.type) {
        case Actions.MOVE: // target=roomName
          return actorRoom.getLinks(gameData).includes(target);
        case Actions.UNLOCK: // target=door object
          return target.rooms.includes(actor.roomName);
        case Actions.ATTACK: // actor object
          return actor.roomName === target.roomName && target.attackable
              && target.isAlive();
        case Actions.CAPTURE: // actor object
          return actor.roomName === target.roomName
              && target.capturable && !actionMap[this.type].captive;
        case Actions.GET: // room item
          return actorRoom.getItems().includes(target)
            && actor.getItems().length < actor.inventory;
        case Actions.DROP: // actor item
          return actor.getItems().includes(target);
        case Actions.USE:
          return (actorRoom.getItems().includes(target) || actor.getItems().includes(target))
              && target.isUsable();
        case Actions.ACTIVATE:
          return actorRoom.getContained(Category.SPECIAL).includes(this.target);
        case Actions.COUNT:
        case Events.LOG:
          return true;
        default:
          throw new Error("Unsupported action validation: " + this.type);
      }
    }

    getMenuText() {
      // TODO make consistent?
      switch(this.type) {
        case Actions.MOVE:
          return this.target;
        case Actions.UNLOCK:
          return "Unlock Grate"; // TODO localize?
        case Actions.ATTACK:
          return "Attack " + this.target.id;
        case Actions.GET:
          return this.target.type;
        case Actions.DROP:
          return "Drop " + this.target.type;
        case Actions.USE:
          return "Use " + this.target.type;
        case Actions.CAPTURE:
          return "Catch " + this.target.id;
        case Actions.ACTIVATE:
          // TODO special text
          return "Activate " + this.target.type;
        default:
          throw new Error("Unsupported action text: " + this.type);
      }
    }

    getEventText(gameData) {
        let type = this.type;
        // TODO record payload, e.g. damage, increment, etc.
        // TODO Generify, obvs
        switch(type) {
          case Actions.MOVE:
            return this.actor.id + " moved to " + this.target + ".";
          case Actions.UNLOCK:
            return this.actor.id + " unlocked " + this.target.id + ".";
          case Actions.ATTACK:
            // TODO passive voice?
            return this.actor.id + " attacked " + this.target.id + ".";
          case Actions.GET:
            return this.actor.id + " picked up " + this.target.type + ".";
          case Actions.DROP:
            return this.actor.id + " dropped " + this.target.type + ".";
          case Actions.USE:
            return this.actor.id + " used " + this.target.type + ".";
          case Actions.CAPTURE:
            return this.actor.id + " captured " + this.target.type + ".";
          case Actions.ACTIVATE:
            return this.actor.id + " activated " + this.target.type + ".";
          case Actions.COUNT:
            return null;
          case Events.LOG:
            // TODO debug flag
            return "Log: " + target;
        }

        return "UNHANDLED EVENT:" + JSON.stringify(event);
    }
}

class TypedClass {

    constructor(json, typeDefs, id, requirements) {
        // Assign characteristics hierarchically
        this.id = id; // Prefer id from data
        if (typeDefs.hasOwnProperty(DEF_DEFAULT)) {  // Type default
            Object.assign(this, typeDefs[DEF_DEFAULT]);
            this.type = DEF_DEFAULT;
        }
        if (json.hasOwnProperty(DEF_TYPE)) { // Specific type
            var jsonType = json[DEF_TYPE];
            if (typeDefs.hasOwnProperty(jsonType)) {
                Object.assign(this, typeDefs[jsonType]);
            } else {
                throw Error("No defined type: " + jsonType);
            }
        }

        if (this.health && !this.hp) {
          this.hp = this.health;
        }

        Object.assign(this, json); // Specific instance
        this.transient = {};
        this.transient.items = [];

        // Validate common properties
        if (!requirements) {
          requirements = [];
        }
        // TODO set category in constructor, validate here
        let mergedRequirements = requirements.concat(
          ["id", "type"])
        for (let req of mergedRequirements) {
          if (!this[req]) {
            throw Error("Typed object is missing required field " + req);
          }
        }
    }

    takesActions() {return this.ai}

    getContained(category) {
      if (this.transient[category]) {
        return this.transient[category];
      }
      return [];
    }

    getItems() {
      if (!this.transient.items) {return [];}

      return this.getContained(Category.ITEMS);
    }

    getActionMap(){ // make map of actions to source
      if (!this.actions) {
        throw Error(id + " has no actionMap")
      }
      let tempOut = {};

      for (let action of this.actions) {
        tempOut[action] = this;
      }
      if (this.getItems()[0]) {
        for (let action of this.getItems()[0].actions) {
          tempOut[action] = this.getItems()[0]; // TODO collision
        }
      }
      return tempOut;
    }

    static create(category, json, def, id) {
      switch(category) {
        case Category.ACTORS:
          return new Actor(json, def, id);
        case Category.DOORS:
          return new Door(json, def, id);
        case Category.SPECIAL:
          return new Special(json, def, id);
        case Category.ITEMS:
          return new Item(json, def, id);
        case Category.ROOMS:
          return new Room(json, def, id);
        default:
          throw new Error("Unsupported category " + category);
      }
    }

    isAlive() {
      if(!this.health) {
        throw Error(this.id + " has no health.");
      }
      return this.hp > 0;
    }
}

class Actor extends TypedClass {
  constructor(json, defs) {
    super(json, defs);
    this.category = Category.ACTORS;
    // TODO default or require: inventory, attack
    // TODO random location option
    let required = ["roomName", "actions"];
    for (let req of required) {
      if (!this.hasOwnProperty(req)) {
          throw new Error("No value for " + req + ": "
              + JSON.stringify(actor));
      }
    }
  }

  takesActions() {
    return super.takesActions() && this.isAlive();
  }
}

class Room extends TypedClass {
  constructor(json, defs, id) {
    super(json, defs, id)
    this.category = Category.ROOMS;
    // declare default variables
    if (!this.doorIds) {this.doorIds = [];}
    if (!this.special) {this.special = [];}
  }

  getLinks(gameData){
      var out = [];
      for (let doorId of this.doorIds) {
        let door = gameData.getByCategoryId(Category.DOORS, doorId);
          out.push(door.other(this.id));
      }
      return out;

      //TODO dspecial and addDoora
  }};

class Door extends TypedClass {
    constructor(json, typeDefs, id) {
        super(json, typeDefs, "door" + id);
        this.category = Category.DOORS;
        if (this.rooms.length != 2) {
            throw new Error("door with " + this.rooms.length + " rooms");
        }
    }

    other(roomName) { // TODO declare elsewwhere
        if (this.rooms[0] === roomName) {
            return this.rooms[1];
        }
        if (this.rooms[1] === roomName) {
            return this.rooms[0];
        }
       throw new Error("room <" + roomName + "> not in doors");
    }
}

class Item extends TypedClass {
  constructor(json, typedefs, id) {
    super(json, typedefs, "item" + id);
    this.category = Category.ITEMS;
    if (!this.actions) {
      this.actions = [];
    }

    // TODO this won't work with saves
    if (this.damage) {
      this.actions.push(Actions.ATTACK);
    }

    if (this.hasOwnProperty("captive")) {
      this.actions.push(Actions.CAPTURE);
    }

  }

  isUsable() {
    // weapons dpon't count
    return tdocument.getElementById(DESTRUCT).innerHTML =his.actions.length > 0;
  }
}

// TODO "counter" amd "increment" but really counting down
class Special extends TypedClass {
  constructor (json, typeDefs, id) {
    super(json, typeDefs, "special" + id);
    this.category = Category.SPECIAL;

    if (this.count) {
      this.startCount = this.count;// TODO names??
      this.incrementVal = new Selector(this.incrementVal);
      if(!this.triggerEvent) {
        throw Error("Counter without triggerEvent");
      } else if (!this.triggerEvent.selector || !this.triggerEvent.effect) {
        throw Error("triggerEvent without effect and selector")
      }
      this.triggerEvent.selector = new Selector(this.triggerEvent.selector);
      // validate effect
      handleEffect({}, this.triggerEvent.effect);
    }
  }

  onActivated() {
    this.activated = !this.activated;
    if (this.activated && this.hasOwnProperty("count")) {
      // Reset to starting count
      this.count = this.startCount;
    }
  }

  increment(gameData) {
    if (this.activated) {
      let inc = this.incrementVal.getNum(gameData);
      if (this.countMultiplier) {
        inc = inc * this.countMultiplier;
      }
      this.count = this.count - inc;
      if (this.count <= 0) {
        this.onTrigger(gameData)
      }
    }
  }

  onTrigger(gameData) {
    let selected = this.triggerEvent.selector.getVals(gameData);
    let effect = this.triggerEvent.effect;
    for (let obj of selected) {
      handleEffect(obj, effect);
    }
  }
}

// TODO put somewhere
function handleEffect(obj, effect) {
  switch (effect) {
    case "kill":
      if (obj.hp) {
        obj.hp = -10000;  // Ta-dah!! you're dead
      }
      break;
    default:
      throw Error("Unhandled effect.");
  }
}

class Selector {
  constructor (json) {
    if (!json) {
      throw Error ("No value to wrap");
    }
    this.json = json;
  }

  getNum(gameData) {
    if (typeof(this.json) === "number") {
      return this.json;
    }
    // TODO param
    return this.getVals(gameData).length;
  }

  // Return wrapped int value, or use selector object to find referenced value(s)
  getVals(gameData) { // TODO gameData query method?
    let all = gameData.getAll();
    let out = all.filter(obj=>this.shouldSelect(obj));
    return out;
  }

  shouldSelect(obj) {
    if (this.json.has) {
      for (let field of this.json.has) {
        if (!obj[field]) {
          return false;
        }
      }
    }
    if (this.json.is) {
      for (let field in this.json.is) {
        if (!obj[field] || !(obj[field] === this.json.is[field])) {
          return false;
        }
      }
    }

    return !obj.health || !obj.isAlive || obj.isAlive(); // TODO generify somehow
  }
}
