/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactNativeMount
 * @flow
 */
'use strict';

var RCTUIManager = require('NativeModules').UIManager;

var ReactNativeTagHandles = require('ReactNativeTagHandles');
var ReactPerf = require('ReactPerf');
var ReactReconciler = require('ReactReconciler');
var ReactUpdateQueue = require('ReactUpdateQueue');
var ReactUpdates = require('ReactUpdates');

var emptyObject = require('emptyObject');
var instantiateReactComponent = require('instantiateReactComponent');
var shouldUpdateReactComponent = require('shouldUpdateReactComponent');

function instanceNumberToChildRootID(rootNodeID, instanceNumber) {
  return rootNodeID + '[' + instanceNumber + ']';
}

/**
 * Mounts this component and inserts it into the DOM.
 *
 * @param {ReactComponent} componentInstance The instance to mount.
 * @param {number} rootID ID of the root node.
 * @param {number} container container element to mount into.
 * @param {ReactReconcileTransaction} transaction
 */
function mountComponentIntoNode(
    componentInstance,
    rootID,
    container,
    transaction) {
  var markup = ReactReconciler.mountComponent(
    componentInstance, rootID, transaction, emptyObject
  );
  componentInstance._isTopLevel = true;
  ReactNativeMount._mountImageIntoNode(markup, container);
}

/**
 * Batched mount.
 *
 * @param {ReactComponent} componentInstance The instance to mount.
 * @param {number} rootID ID of the root node.
 * @param {number} container container element to mount into.
 */
function batchedMountComponentIntoNode(
    componentInstance,
    rootID,
    container) {
  var transaction = ReactUpdates.ReactReconcileTransaction.getPooled();
  transaction.perform(
    mountComponentIntoNode,
    null,
    componentInstance,
    rootID,
    container,
    transaction
  );
  ReactUpdates.ReactReconcileTransaction.release(transaction);
}

/**
 * As soon as `ReactMount` is refactored to not rely on the DOM, we can share
 * code between the two. For now, we'll hard code the ID logic.
 */
var ReactNativeMount = {
  instanceCount: 0,

  _instancesByContainerID: {},

  /**
   * @param {ReactComponent} instance Instance to render.
   * @param {containerTag} containerView Handle to native view tag
   */
  renderComponent: function(
    nextElement: ReactElement,
    containerTag: number,
    callback?: ?(() => void)
  ): ?ReactComponent {
    var topRootNodeID = ReactNativeTagHandles.tagToRootNodeID[containerTag];
    if (topRootNodeID) {
      var prevComponent = ReactNativeMount._instancesByContainerID[topRootNodeID];
      if (prevComponent) {
        var prevElement = prevComponent._currentElement;
        if (shouldUpdateReactComponent(prevElement, nextElement)) {
          ReactUpdateQueue.enqueueElementInternal(prevComponent, nextElement);
          if (callback) {
            ReactUpdateQueue.enqueueCallbackInternal(prevComponent, callback);
          }
          return prevComponent;
        } else {
          ReactNativeMount.unmountComponentAtNode(containerTag);
        }
      }
    }

    if (!ReactNativeTagHandles.reactTagIsNativeTopRootID(containerTag)) {
      console.error('You cannot render into anything but a top root');
      return;
    }

    var topRootNodeID = ReactNativeTagHandles.allocateRootNodeIDForTag(containerTag);
    ReactNativeTagHandles.associateRootNodeIDWithMountedNodeHandle(
      topRootNodeID,
      containerTag
    );

    var instance = instantiateReactComponent(nextElement);
    ReactNativeMount._instancesByContainerID[topRootNodeID] = instance;

    var childRootNodeID = instanceNumberToChildRootID(
      topRootNodeID,
      ReactNativeMount.instanceCount++
    );

    // The initial render is synchronous but any updates that happen during
    // rendering, in componentWillMount or componentDidMount, will be batched
    // according to the current batching strategy.

    ReactUpdates.batchedUpdates(
      batchedMountComponentIntoNode,
      instance,
      childRootNodeID,
      topRootNodeID
    );
    var component = instance.getPublicInstance();
    if (callback) {
      callback.call(component);
    }
    return component;
  },

  /**
   * @param {View} view View tree image.
   * @param {number} containerViewID View to insert sub-view into.
   */
  _mountImageIntoNode: ReactPerf.measure(
    // FIXME(frantic): #4441289 Hack to avoid modifying react-tools
    'ReactComponentBrowserEnvironment',
    'mountImageIntoNode',
    function(mountImage, containerID) {
      // Since we now know that the `mountImage` has been mounted, we can
      // mark it as such.
      ReactNativeTagHandles.associateRootNodeIDWithMountedNodeHandle(
        mountImage.rootNodeID,
        mountImage.tag
      );
      var addChildTags = [mountImage.tag];
      var addAtIndices = [0];
      RCTUIManager.manageChildren(
        ReactNativeTagHandles.mostRecentMountedNodeHandleForRootNodeID(containerID),
        null,         // moveFromIndices
        null,         // moveToIndices
        addChildTags,
        addAtIndices,
        null          // removeAtIndices
      );
    }
  ),

  /**
   * Standard unmounting of the component that is rendered into `containerID`,
   * but will also execute a command to remove the actual container view
   * itself. This is useful when a client is cleaning up a React tree, and also
   * knows that the container will no longer be needed. When executing
   * asynchronously, it's easier to just have this method be the one that calls
   * for removal of the view.
   */
  unmountComponentAtNodeAndRemoveContainer: function(
    containerTag: number
  ) {
    ReactNativeMount.unmountComponentAtNode(containerTag);
    // call back into native to remove all of the subviews from this container
    RCTUIManager.removeRootView(containerTag);
  },

  /**
   * Unmount component at container ID by iterating through each child component
   * that has been rendered and unmounting it. There should just be one child
   * component at this time.
   */
  unmountComponentAtNode: function(containerTag: number): boolean {
    if (!ReactNativeTagHandles.reactTagIsNativeTopRootID(containerTag)) {
      console.error('You cannot render into anything but a top root');
      return false;
    }

    var containerID = ReactNativeTagHandles.tagToRootNodeID[containerTag];
    var instance = ReactNativeMount._instancesByContainerID[containerID];
    if (!instance) {
      return false;
    }
    ReactNativeMount.unmountComponentFromNode(instance, containerID);
    delete ReactNativeMount._instancesByContainerID[containerID];
    return true;
  },

  /**
   * Unmounts a component and sends messages back to iOS to remove its subviews.
   *
   * @param {ReactComponent} instance React component instance.
   * @param {string} containerID ID of container we're removing from.
   * @final
   * @internal
   * @see {ReactNativeMount.unmountComponentAtNode}
   */
  unmountComponentFromNode: function(
    instance: ReactComponent,
    containerID: string
  ) {
    // Call back into native to remove all of the subviews from this container
    ReactReconciler.unmountComponent(instance);
    var containerTag =
      ReactNativeTagHandles.mostRecentMountedNodeHandleForRootNodeID(containerID);
    RCTUIManager.removeSubviewsFromContainerWithID(containerTag);
  },

  getNode: function<T>(id: T): T {
    return id;
  }
};

ReactNativeMount.renderComponent = ReactPerf.measure(
  'ReactMount',
  '_renderNewRootComponent',
  ReactNativeMount.renderComponent
);

module.exports = ReactNativeMount;
