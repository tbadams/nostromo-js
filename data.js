"use strict"

const DEF_DEFAULT = "default";
const DEF_TYPE = "type";
const EVENT_KEY_MISSED = "missed";

const CAT_CAPTURE_CHANCE = 0.20; // TODO move to Presenter
const DEFAULT_ACTION_DURATION = 5;

const Actions = {
  MOVE:"move",
  UNLOCK:"unlock",
  ATTACK:"attack",
  GET:"get",
  DROP:"drop",
  CAPTURE:"capture",  // TODO generic target action
  TICK:"tick",
  ACTIVATE:"activate",
  ENTER: "enter"
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
// Visibility states of events, used for displaying events in log.
const Observed = {
    SELF:"self",
    ACTIVE:"active", // Selected PC present
    PASSIVE:"passive", // PC present but not selected
    NONE:"none" // event initiated by user
}

class GameData {
  constructor(json) {
    Object.assign(this, json);
    this.transient = {byId:{}};
    this.history = [];
  }

  gameLoop() {
      if (this.isOver()) {
        return;
      }
      var eventBus = []
      var scheduler = this.scheduler;

      // TODO copy gamedata
      // Handle scheduled events
      while (!scheduler.isEmpty() && scheduler.peek().time <= this.state.time) {
          eventBus.push(scheduler.dequeue());
      }
      // check validity *before* resolving any Actions
      eventBus = eventBus.filter(event=>event.isValid(this));
      for (let event of eventBus) {
          Action.handleAction(event, this);
      }

     // Queue new actions
      for (let actor of this.getAll()) {
        // not preoccupied doing something, like being dead or in a box
          if (actor.takesActions() && !this.isBusy(actor.id)) {
              var choices = Action.getChoices(actor, this);
              // AI actions
              if (actor.ai != AI_PLAYER) {
                  // TODO Specific AIs
                  if (choices.length > 0) {
                    let attacks = choices.filter(action => action.type === Actions.ATTACK);
                    let action;
                    if (attacks.length > 0) {
                      action = chooseRandom(attacks);
                    } else {
                      action = chooseRandom(choices);
                    }
                    this.queueAction(actor, action, this);
                  }
              } else {
                   // TODO handle input
              }
          }
      }

      // cull newly invalid actions
      let contents = scheduler.toArray();
      contents = contents.filter((action)=>action.isValid(this));
      scheduler.clear();
      for(let action of contents) {
        scheduler.add(action);
      }
      // TODO cleanup, maintenance (?)
    if (this.isOver()) {
      this.client.onGameEnd(this);
    }
     this.state.time = this.state.time + 1;
  }

  getDefs(defType) {
    if(this.defs.hasOwnProperty(defType)) {
        return this.defs[defType];
    }
    throw Error("No defs type '" + defType + "'.")
  }

  getAll() {
    return valuesAsList(this.getCategoryMap(CATEGORY_ALL));
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

  selectPc(pcId) {
    let pc = this.getByCategoryId(Category.ACTORS, pcId);
    if (pc.ai === AI_PLAYER && pc.isAlive()) {
      this.selected = pcId; // TODO rename selectedId
    } else {
      this.selected = null;
    }
  }

  pcSelected() { // TODO selectedId
    return this.selected && this.getByCategoryId(Category.ACTORS, this.selected).isAlive();
  }

  isBusy(actorId) {
    var busyActors = this.scheduler.toArray().map((a)=>a.getActor().id);
    return busyActors.includes(actorId);
  }

  getPendingAction(actorId) {
    let actorsActions = this.scheduler.toArray().filter(a=>a.actorId === actorId);
    if (actorsActions.length > 1) {
      throw Error("Multiple pending actions for actor " + actorId);
    }
    if (actorsActions.length === 1) {
      return actorsActions[0];
    }
    return null;
  }

  isDebug() {
    return this.config && this.config.debug;
  }

  isOver() {
    return this.getPcs().filter(actor => actor.takesActions()).length === 0
    || !valuesAsList(this.getCategoryMap(Category.ROOMS)).every(room => room.ship);
    // ship launched
  }

  isShipDestroyed() {
  return !valuesAsList(this.getCategoryMap(Category.ROOMS))
        .every(shipRoom => !shipRoom.health || shipRoom.isAlive());
  }

  queueAction(actor, action, gameData) {
    if (action.isValid(gameData)) {
      let speed = actor.speed ? actor.speed : 1;
      action.time = gameData.state.time + (action.duration * speed);
      gameData.scheduler.enqueue(action);
    } else {
      gameData.scheduler.enqueue(new Action(Events.LOG, "invalid action taken", 0));
    }
  }

  getString(key) {
    return this.strings[key];
  }
}

class Action {
    constructor(type, target, actor, duration, required) { // TODO swap target and actor
        this.type = type;
        this.targetId = target != null ? target.id : null;
        this.actorId = actor.id;
        this.transient = {};
        this.transient.actor = actor;
        this.transient.target = target;
        if (!duration) {
          this.duration = DEFAULT_ACTION_DURATION;
        } else {
          this.duration = duration;
        }

        this.source = actor.getActionMap()[type];

        for (let requirement of ["type", "actorId"]) {
          if (!this[requirement]) {
            throw new Error("field " + requirement + " must be non null for type Action");
          }
        }
    }

    getActor() {
      return this.transient.actor;
    }

    getTarget() {
      return this.transient.target;
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
              addIfSupported(new Action(Actions.GET, item, actor, 1));
            }
          }
          for (let doorId of room.doorIds) {
            let door = gameData.getByCategoryId(Category.DOORS, doorId)
            let otherRoom = gameData.getByCategoryId(Category.ROOMS, door.other(room.id));
            if (!door.locked) {
              addIfSupported(new Action(Actions.MOVE, otherRoom, actor));
            } else {
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
            addIfSupported(new Action(Actions.DROP, item, actor, 1));
          }
        }

        // For logic actors
        addIfSupported(new Action(Actions.TICK, null, actor, 1));

        if (room) { // TODO deduplicate w/ above
          let specialsHere = room.getContained(Category.SPECIAL);
          for (let special of specialsHere) {
            if (special.floorAction) {
              let target = special.floorAction.targetId ?
                  gameData.getByCategoryId(CATEGORY_ALL, special.floorAction.targetId)
                  : special;
                let actionType = special.floorAction.type ? special.floorAction.type : Actions.ACTIVATE;
              let action = new Action(actionType, target, actor, 1);
              addIfSupported(action);
          }
        }
      }

        return out;
    }

    static handleAction(event, gameData) {
        event.observe(gameData);

        let effects = [];
        let actor = event.getActor(); // cur. object
        let actorRoom = gameData // TODO make room part of event?
            .getByCategoryId(Category.ROOMS, actor.roomName);
        let target = event.getTarget();
        if (event.type === Actions.MOVE) {
            let targetRoom = event.getTarget();
            actor.move(actorRoom, targetRoom);
        } else if (event.type === Actions.UNLOCK) {
            target.locked = false;
        } else if (event.type === Actions.ATTACK) {
            let weapon = event.source;
            let targetWasAlive = target.isAlive();
            if (weapon) {
              target.giveDamage(weapon.damage);
              effects.push({msg:target.id + " is being wounded."}); // TODO ??? not OK??
              if(!weapon.nobleed && target.acidBlood) {
                // TODO log
                actorRoom.giveDamage(target.acidBlood);
              }
              if (targetWasAlive && !target.isAlive()) {
                effects.push({msg: target.id + " has collapsed."});
              }
            }
        } else if (event.type === Actions.GET) {
          target.move(actorRoom, actor);
        } else if (event.type === Actions.DROP) {
          target.move(actor, actorRoom);
        } else if (event.type === Actions.ENTER) {
          actor.move(actorRoom, target);
          actor.breathe = false; // Remove if can ever leave hypersleep
        } else if (event.type === Actions.CAPTURE) {
          let hit = Math.random() < CAT_CAPTURE_CHANCE;
          if (hit) {
            // TODO use .move()
            event.source.captive = target;
            target.roomName = VOID;
            gameData.actors.splice(gameData.actors.indexOf(target));
          } else {
            event[EVENT_KEY_MISSED] = true;
          }
          // TODO I think this was a mistake and special passives should not use the scheduler, lbh it's a hack
        } else if (event.type === Actions.TICK) {
          actor.tick(gameData);
        } else if (event.type === Actions.ACTIVATE) {
          let targetObject =  event.getTarget();
          if (targetObject.hasOwnProperty("activated")) {
            targetObject.activated = !targetObject.activated;
            if (targetObject.activated && targetObject.hasOwnProperty("count")) {
              // Reset to starting count
              targetObject.count = targetObject.startCount;
              // why, why am I doing this
            } else if (!targetObject.hasOwnProperty("count")){
              targetObject.onTrigger(gameData);
            }
          }
        } else {
          throw Error("undefined action " + event)
        }
        gameData.client.log(event, gameData);
        gameData.history.push(event);
        for (let effect of effects) {
          gameData.client.log(effect, gameData);
          gameData.history.push(effect);
        }
    }

// Calculate actors witnessing this event, and provide front-end state.
    observe(gameData) {
      let actor = this.getActor(); // cur. object
      let actorRoom = gameData // TODO make room part of event?
          .getByCategoryId(Category.ROOMS, actor.roomName);
      let target = this.getTarget();

      let observers = {};
      let scopes = [];
      if (actorRoom) { // some actors have no location
        scopes.push(actorRoom);
      }
      if (this.type === Actions.MOVE) {
        if (!target) {
          throw Error("Move with no destination");
        }
        scopes.push(target);
      }

      for (let scope of scopes) {
        // TODO distinguish 'observers'
        for (let observer of scope.getContained(Category.ACTORS)) {
          observers[observer.id] = observer;
        }
      }

      let status = Observed.NONE;
      let selectedId = gameData.selected;
      for (let key in observers) {
        let observer = observers[key];
        if (observer.isPc() && observer.isAlive()) {
            if (observer.id === selectedId) {
              status = Observed.ACTIVE;
              break;
            } else {
              status = Observed.PASSIVE;
            }
        }
      }

      this.observed = status;
      this.observers = observers;
    }

    isValid(gameData) { // TODO must die
      if (!gameData) {throw new Error("NO MORE NULL GAMEDATA");}

      let actor = this.getActor(); // object
      let actionMap = actor.getActionMap();
      let target = this.getTarget();

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
          // TODO if refactor target to door, they're both in same room
          // TODO oh would also need to make rooms contain doors :-p
          return actorRoom.getLinks(gameData).includes(target.id);
        case Actions.UNLOCK: // target=door object
          return target.rooms.includes(actor.roomName); // TODO refactor to room contains
        case Actions.ATTACK: // actor object
          return actor.roomName === target.roomName && target.attackable
              && target.isAlive();
        case Actions.CAPTURE: // actor object
          return actor.roomName === target.roomName
              && target.capturable && !actionMap[this.type].captive;
        case Actions.GET: // room item
          return actor.roomName === target.roomName
            && actor.getItems().length < actor.inventory;
        case Actions.DROP: // actor item
          return actor.getItems().includes(target);
        case Actions.ENTER:
          return actor.roomName === target.roomName;
        case Actions.ACTIVATE:
          return actorRoom.getContained(Category.SPECIAL).includes(this.getTarget());
        case Actions.TICK:
        case Events.LOG:
          return true;
        default:
          throw new Error("Unsupported action validation: " + this.type);
      }
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
        // TODO generify into "supported children types" or something
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
      if (category === CATEGORY_ALL) {
        let out = [];
        for (let key in this.transient) {
          out = out.concat(out, this.getContained(key));
        }
        return out;
      }
      if (this.transient[category]) {
        return this.transient[category];
      }
      return [];
    }

    contains(object) {
      return this.getContained(CATEGORY_ALL).includes(object);
    }

    remove(contained) {
      if (!this.contains(contained)) {throw Error("Can't remove "
          + contained.id + ", not contained.");}
      let category = contained.category;
      this.transient[category] = this.transient[category]
          .filter((thing)=>thing != contained);
    }

    insert(object) {
      if (!this.transient[object.category]) {
        this.transient[object.category] = [];
      }
      if (this.contains(object)) {throw Error(object.id
          + " already contained.");}
      this.transient[object.category].push(object);
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

    // Resolve movement action, handle state changes
    move(originObject, destinationObject) {
      if (!originObject || !destinationObject) {
        throw Error("null participants in move");
      }
      if (!originObject.contains(this)) {
        throw Error ("move not at origin");
      }

      this.roomName = destinationObject.id;
      originObject.remove(this);
      destinationObject.insert(this);
    }

    giveDamage(damage) {
      if (this.health) {
        let prevHp = this.hp;
        this.hp -= damage;
        // TODO other notable thresholds
        if (prevHp > 0 && this.hp <= 0 && this.onDeath) {
          // died
          this.onDeath()
        }
      }
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

  isPc() {
    return this.ai === AI_PLAYER;
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
  }

  onDeath() {
    for (let child of this.getContained(CATEGORY_ALL)) {
      handleEffect(child, "kill");
    }
  }
}

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
}

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

      // validate effect
      // handleEffect({}, this.triggerEvent.effect);
    }

    if (this.triggerEvent && this.triggerEvent.selector) {
      this.triggerEvent.selector = new Selector(this.triggerEvent.selector);
    }
  }

  tick(gameData) { // passive action done every tick
    if (this.activated) {
      if (this.count) {
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
  }

  onTrigger(gameData) {
    let selected = this.triggerEvent.selector.getVals(gameData);
    let effect = this.triggerEvent.effect;
    let params = this.triggerEvent.params;
    for (let obj of selected) {
      handleEffect(obj, effect, params);
    }
  }
}

// TODO put somewhere
function handleEffect(obj, effect, params) {
  switch (effect) {
    case "kill":
      obj.giveDamage(10000);
      break;
    case "set":
      Object.assign(obj, params);
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
